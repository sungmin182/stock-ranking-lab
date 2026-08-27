/**
 * DART 오픈API — 재무제표·배당 수집
 *
 *   출처  https://opendart.fss.or.kr/api/...
 *   인증  질의 문자열 crtfc_key (opendart.fss.or.kr 에서 무료 발급)
 *
 * data/prices.json 에 들어 있는 종목만 대상으로
 *   data/financials.json  ← 종목코드별 재무 요약
 * 을 만든다.
 *
 * ── PER·PBR·ROE 를 왜 여기서 만드나 ─────────────────────
 * KRX 오픈API 는 시세와 시가총액까지만 준다. PER·PBR·ROE 는 재무제표가
 * 있어야 나오는 값이라, DART 에서 자산·부채·자본·매출·순이익을 받아
 * scripts/build.mjs 에서 시가총액과 엮어 직접 계산한다.
 *
 *   PER  = 시가총액 ÷ 당기순이익
 *   PBR  = 시가총액 ÷ 자본총계
 *   ROE  = 당기순이익 ÷ 자본총계
 *   부채비율 = 부채총계 ÷ 자본총계
 *
 * 어디선가 받아온 숫자가 아니라 공시 원자료에서 계산한 값이므로,
 * 왜 이 값이 나왔는지 화면에서 그대로 설명할 수 있다.
 *
 * ── 캐시 ────────────────────────────────────────────────
 * 재무제표는 분기에 한 번 바뀐다. cache/dart 에 종목별로 담아 두고
 * TTL(기본 30일)이 지난 것만 다시 받는다. 2,600종목을 매일 새로 받으면
 * DART 하루 한도(20,000건)를 금방 쓴다.
 */
import path from 'node:path';
import { get, pool, readJson, writeJson, unzipFirst, num, sleep } from './lib.mjs';

const KEY = process.env.DART_API_KEY;
const BASE = 'https://opendart.fss.or.kr/api';
const CACHE = 'cache/dart';
const TTL_MS = Number(process.env.TTL_DAYS ?? 30) * 86400_000;
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 3);

/** 사업보고서. 반기·분기는 11012 / 11013 / 11014 */
const ANNUAL = '11011';

/**
 * 계정과목명 → 우리가 쓰는 이름.
 *
 * ── 이름을 정확히 맞추면 안 된다 ────────────────────────
 * 처음에는 '당기순이익' 으로 정확히 같은 이름만 찾았는데, 2,623종목 전부에서
 * 순이익이 비었다(매출·자본은 멀쩡히 들어왔다). DART 는 회사마다 표기가 달라
 * '당기순이익(손실)' 처럼 괄호를 붙여 오기 때문이다. PER 과 ROE 가 둘 다
 * 순이익으로 계산되므로 이 한 줄 때문에 두 지표가 통째로 비었다.
 *
 * 그래서 이름이 같거나 **뒤에 괄호만 붙은 경우**까지 잡는다.
 * 금융사가 '매출액' 대신 쓰는 '영업수익' 도 같이 받는다.
 */
const ACCOUNTS = [
  ['assets', ['자산총계']],
  ['liabilities', ['부채총계']],
  ['equity', ['자본총계']],
  ['revenue', ['매출액', '영업수익']],
  ['operatingIncome', ['영업이익']],
  ['netIncome', ['당기순이익', '반기순이익', '분기순이익']],
];

/**
 * 계정과목명을 우리 이름으로 바꾼다. 못 알아보면 null.
 * exact 가 true 면 괄호 변형이 아니라 이름이 정확히 같았다는 뜻이다.
 */
function accountKey(name) {
  // 공백을 없애고, 공시에 섞여 들어오는 전각 괄호를 반각으로 맞춘다
  const n = String(name ?? '')
    .replace(/\s/g, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')');
  for (const [key, heads] of ACCOUNTS) {
    for (const h of heads) {
      if (n === h) return { key, exact: true };
      // '당기순이익(손실)' 은 받고 '법인세차감전순이익' 은 안 받는다
      if (n.startsWith(`${h}(`)) return { key, exact: false };
    }
  }
  return null;
}

/**
 * 알아보지 못한 계정과목명. 매칭이 또 어긋났을 때 무엇을 놓쳤는지 알려면
 * 실물 이름이 필요한데, 한 번 돌리는 데 시간이 걸려 그때그때 못 본다.
 */
const unknownAccounts = new Map();

if (!KEY) {
  console.error(
    [
      '',
      'DART_API_KEY 가 없습니다.',
      '',
      '  1. https://opendart.fss.or.kr 에서 무료 가입 후 인증키를 발급받으세요.',
      '  2. 발급된 키를 환경변수로 넣고 다시 실행하세요.',
      '',
      '     PowerShell:  $env:DART_API_KEY = "발급받은키"; npm run sync:financials',
      '     bash:        DART_API_KEY=발급받은키 npm run sync:financials',
      '',
      '재무 없이 시세만으로도 사이트는 돌아갑니다 — PER·PBR·ROE 칸이 빌 뿐입니다.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

/**
 * 종목코드 → DART 고유번호(corp_code) 표.
 *
 * 이 목록은 zip 으로만 나온다. 그것 하나 때문에 의존성을 늘리고 싶지 않아
 * lib.mjs 의 unzipFirst 로 직접 푼다. 한 달에 한 번만 받는다.
 */
async function loadCorpMap() {
  const file = path.join(CACHE, 'corp-map.json');
  const cached = await readJson(file);
  if (cached && Date.now() - cached.at < TTL_MS) {
    console.log(`고유번호 표 캐시 재사용 (${Object.keys(cached.map).length.toLocaleString('ko-KR')}건)`);
    return cached.map;
  }

  console.log('DART 고유번호 표 내려받는 중…');
  const buf = await get(`${BASE}/corpCode.xml?crtfc_key=${KEY}`, { asBuf: true });

  // 키가 잘못되면 zip 대신 짧은 JSON 이 온다
  if (buf.length < 1000 && buf.toString('utf8').includes('status')) {
    throw new Error(`DART 응답: ${buf.toString('utf8')}`);
  }

  const xml = unzipFirst(buf).toString('utf8');
  const map = {};
  // <list><corp_code>…</corp_code><corp_name>…</corp_name><stock_code>…</stock_code></list>
  for (const m of xml.matchAll(/<list>([\s\S]*?)<\/list>/g)) {
    const block = m[1];
    const field = (tag) => block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() ?? '';
    const stock = field('stock_code');
    if (!stock || stock.length !== 6) continue; // 비상장은 종목코드가 비어 있다
    map[stock] = { corp: field('corp_code'), name: field('corp_name') };
  }

  await writeJson(file, { at: Date.now(), map });
  console.log(`  상장 ${Object.keys(map).length.toLocaleString('ko-KR')}건`);
  return map;
}

/**
 * 다중회사 주요계정 — 한 번에 최대 100개 회사.
 * 2,600종목이면 26번이면 끝난다. 종목마다 부르면 2,600번이다.
 */
async function fetchAccounts(corpCodes, year) {
  const url =
    `${BASE}/fnlttMultiAcnt.json?crtfc_key=${KEY}` +
    `&corp_code=${corpCodes.join(',')}&bsns_year=${year}&reprt_code=${ANNUAL}`;
  // 100개 회사를 한 번에 물으면 응답이 느리다. 실제로 기본 60초를 넘겨 죽은 적이 있다.
  const res = await get(url, { timeout: 120_000 });
  // 013 = 조회된 데이터 없음. 오류가 아니라 "그 해 보고서가 없다"는 뜻이다.
  if (res.status !== '000') return [];
  return res.list ?? [];
}

/**
 * 한 회사의 한 해 계정을 정리한다.
 *
 * 연결(CFS)과 개별(OFS)이 함께 오면 연결을 쓴다. 지주회사나 해외 자회사가
 * 큰 기업은 개별만 보면 실제 규모와 크게 어긋난다.
 */
function reduceAccounts(rows) {
  const out = { fs: null };
  const preferred = rows.some((r) => r.fs_div === 'CFS') ? 'CFS' : 'OFS';
  // 어느 항목이 정확한 이름으로 들어왔는지. 괄호 변형이 정확한 값을 덮지 않게 한다.
  const exactly = new Set();

  for (const r of rows) {
    if (r.fs_div !== preferred) continue;
    const hit = accountKey(r.account_nm);
    if (!hit) {
      const nm = String(r.account_nm ?? '').trim();
      if (nm) unknownAccounts.set(nm, (unknownAccounts.get(nm) ?? 0) + 1);
      continue;
    }
    /*
     * '당기순이익' 과 '당기순이익(지배기업 소유주지분)' 이 함께 오는 회사가 있다.
     * 우리가 쓰려는 것은 전체 순이익이므로, 정확한 이름을 이미 받았으면
     * 괄호가 붙은 쪽으로 덮어쓰지 않는다.
     */
    if (exactly.has(hit.key) && !hit.exact) continue;
    if (hit.exact) exactly.add(hit.key);

    out.fs = preferred;
    out[hit.key] = num(r.thstrm_amount);
    // 전기 값은 성장률 계산에 쓴다
    const prev = num(r.frmtrm_amount);
    if (prev != null) out[`prev_${hit.key}`] = prev;
  }
  return out;
}

/**
 * 배당에 관한 사항 — 회사 하나씩만 부를 수 있다.
 * 주당 현금배당금(보통주)만 꺼내 온다. 배당수익률은 build.mjs 에서
 * 현재 주가로 다시 계산한다(공시된 수익률은 공시 시점 주가 기준이다).
 */
async function fetchDividend(corp, year) {
  const url =
    `${BASE}/alotMatter.json?crtfc_key=${KEY}` +
    `&corp_code=${corp}&bsns_year=${year}&reprt_code=${ANNUAL}`;

  /*
   * "배당을 안 줬다" 와 "물어보지 못했다" 는 다르다.
   *
   * 둘을 같이 null 로 처리했더니, 요청이 한 번 실패한 회사가 30일 동안
   * "무배당" 으로 캐시에 박혔다. 실패는 undefined 로 돌려 캐시에 넣지 않고
   * 다음 실행에서 다시 묻게 한다.
   */
  let res;
  try {
    res = await get(url);
  } catch {
    return undefined;
  }
  // 013 = 조회된 데이터 없음. 배당 공시 자체가 없다는 뜻이라 "무배당" 으로 친다.
  if (res.status === '013') return null;
  if (res.status !== '000') return undefined;

  for (const row of res.list ?? []) {
    const se = String(row.se ?? '').replace(/\s/g, '');
    const kind = String(row.stock_knd ?? '');
    if (!se.includes('주당현금배당금')) continue;
    if (kind && !kind.includes('보통')) continue;
    const dps = num(row.thstrm);
    if (dps != null && dps > 0) return dps;
  }
  return null;
}

async function main() {
  const prices = await readJson('data/prices.json');
  if (!prices) {
    console.error('data/prices.json 이 없습니다. npm run sync:prices 를 먼저 실행하세요.');
    process.exit(1);
  }

  const corpMap = await loadCorpMap();

  /*
   * 어느 해 사업보고서를 볼 것인가.
   *
   * 사업보고서는 결산 후 3개월 안에 올라온다(12월 결산이면 이듬해 3월 말).
   * 그래서 4월 이후면 작년 것이 있고, 1~3월이면 재작년 것까지만 확정이다.
   */
  const now = new Date();
  const year = String(now.getFullYear() - (now.getMonth() >= 3 ? 1 : 2));
  console.log(`${year}년 사업보고서 기준`);

  // 상장 종목 중 DART 에 고유번호가 있는 것만
  const targets = prices.stocks
    .map((s) => ({ code: s.code, name: s.name, ...corpMap[s.code] }))
    .filter((t) => t.corp);
  console.log(`대상 ${targets.length.toLocaleString('ko-KR')}종목 (전체 ${prices.stocks.length.toLocaleString('ko-KR')})`);

  /*
   * 캐시에는 원본이 아니라 "해석이 끝난 값" 이 들어간다. 그래서 해석 방식을
   * 고치면 옛 캐시를 그대로 쓰는 한 고친 것이 반영되지 않는다 — 실제로
   * 순이익 매칭을 고치고도 캐시 때문에 그대로 비어 있을 뻔했다.
   * 파일 이름에 번호를 넣어, 아래 번호를 올리면 저절로 다시 받게 한다.
   * (배당 캐시는 해석이 따로라 건드리지 않는다. 2,600건을 다시 받으면 한 시간이다.)
   */
  const PARSE_VERSION = 2;
  const cacheFile = path.join(CACHE, `fin-${year}-v${PARSE_VERSION}.json`);
  const cache = (await readJson(cacheFile)) ?? {};
  const fresh = (code) => cache[code] && Date.now() - cache[code].at < TTL_MS;

  // ── 재무제표: 100개씩 묶어서 ────────────────────────────
  const stale = targets.filter((t) => !fresh(t.code));
  console.log(`재무제표 ${stale.length.toLocaleString('ko-KR')}종목 갱신 (캐시 ${(targets.length - stale.length).toLocaleString('ko-KR')})`);

  const batches = [];
  for (let i = 0; i < stale.length; i += 100) batches.push(stale.slice(i, i + 100));

  let done = 0;
  let failedBatches = 0;
  for (const [i, batch] of batches.entries()) {
    let rows;
    try {
      rows = await fetchAccounts(batch.map((t) => t.corp), year);
    } catch (err) {
      /*
       * 묶음 하나가 실패해도 나머지는 받는다.
       *
       * 전에는 여기서 예외가 그대로 튀어나가 2,600종목을 다 받아 놓고도
       * 마지막 묶음 하나 때문에 통째로 날렸다(DART 응답이 60초를 넘겼다).
       * 실패한 묶음의 종목은 캐시에 안 들어가므로 다음 실행에서 저절로 다시 받는다.
       */
      failedBatches++;
      console.warn(`\n  묶음 ${i + 1}/${batches.length} 실패(다음 실행에서 다시 받음): ${err.message.split('\n')[0]}`);
      await sleep(1000);
      continue;
    }

    const byCorp = new Map();
    for (const r of rows) {
      if (!byCorp.has(r.corp_code)) byCorp.set(r.corp_code, []);
      byCorp.get(r.corp_code).push(r);
    }
    for (const t of batch) {
      cache[t.code] = { at: Date.now(), corp: t.corp, corpName: t.name, ...reduceAccounts(byCorp.get(t.corp) ?? []) };
    }
    done += batch.length;
    process.stdout.write(`\r  ${done.toLocaleString('ko-KR')} / ${stale.length.toLocaleString('ko-KR')}`);

    // 중간에 끊겨도 여기까지는 남는다
    if ((i + 1) % 5 === 0) await writeJson(cacheFile, cache);
    await sleep(150);
  }
  if (batches.length) process.stdout.write('\n');
  if (failedBatches) console.warn(`  묶음 ${failedBatches}개 실패 — 그만큼은 이번 결과에서 빠집니다`);
  await writeJson(cacheFile, cache);

  // ── 배당: 회사마다 한 번씩 ──────────────────────────────
  const divCacheFile = path.join(CACHE, `div-${year}.json`);
  const divCache = (await readJson(divCacheFile)) ?? {};
  const divStale = targets.filter((t) => !(divCache[t.code] && Date.now() - divCache[t.code].at < TTL_MS));
  console.log(`배당 ${divStale.length.toLocaleString('ko-KR')}종목 갱신 (캐시 ${(targets.length - divStale.length).toLocaleString('ko-KR')})`);

  let dDone = 0;
  let divFailed = 0;
  await pool(divStale, CONCURRENCY, async (t) => {
    const dps = await fetchDividend(t.corp, year);
    // undefined = 물어보지 못했다. 캐시에 넣지 않아야 다음 실행에서 다시 묻는다.
    if (dps === undefined) divFailed++;
    else divCache[t.code] = { at: Date.now(), dps };
    dDone++;
    if (dDone % 50 === 0) {
      process.stdout.write(`\r  ${dDone.toLocaleString('ko-KR')} / ${divStale.length.toLocaleString('ko-KR')}`);
      // 중간에 끊겨도 여기까지는 남는다
      await writeJson(divCacheFile, divCache);
    }
  });
  if (divStale.length) process.stdout.write('\n');
  if (divFailed) console.warn(`  배당 조회 ${divFailed.toLocaleString('ko-KR')}건 실패 — 다음 실행에서 다시 받습니다`);
  await writeJson(divCacheFile, divCache);

  // ── 합치기 ──────────────────────────────────────────────
  const out = {};
  let withFs = 0;
  let withDiv = 0;
  for (const t of targets) {
    const fin = cache[t.code];
    if (!fin?.fs) continue;
    const dps = divCache[t.code]?.dps ?? null;
    if (dps) withDiv++;
    withFs++;
    out[t.code] = {
      corp: t.corp,
      fs: fin.fs,
      year: Number(year),
      assets: fin.assets ?? null,
      liabilities: fin.liabilities ?? null,
      equity: fin.equity ?? null,
      revenue: fin.revenue ?? null,
      operatingIncome: fin.operatingIncome ?? null,
      netIncome: fin.netIncome ?? null,
      prevRevenue: fin.prev_revenue ?? null,
      prevOperatingIncome: fin.prev_operatingIncome ?? null,
      prevNetIncome: fin.prev_netIncome ?? null,
      dps,
    };
  }

  await writeJson('data/financials.json', {
    year: Number(year),
    report: '사업보고서',
    source: 'DART 오픈API (opendart.fss.or.kr)',
    count: withFs,
    stocks: out,
  });
  console.log(`\ndata/financials.json — 재무 ${withFs.toLocaleString('ko-KR')}종목 · 배당 ${withDiv.toLocaleString('ko-KR')}종목`);

  /*
   * 항목별로 몇 종목이나 채워졌는지 찍는다.
   *
   * "재무 2,623종목" 만 보고 넘어갔다가 순이익이 0종목인 것을 배포 뒤에야
   * 알았다. 계정 이름 하나가 어긋나면 그 줄만 조용히 비는데, 합계만 보면
   * 멀쩡해 보인다. 항목별로 세어 두면 다음에는 로그에서 바로 걸린다.
   */
  const rows = Object.values(out);
  const coverage = ['revenue', 'operatingIncome', 'netIncome', 'assets', 'liabilities', 'equity', 'dps'];
  console.log('  항목별 채워진 종목 수:');
  const missing = [];
  for (const k of coverage) {
    const n = rows.filter((r) => r[k] != null).length;
    console.log(`    ${k.padEnd(17)} ${n.toLocaleString('ko-KR')}`);
    // 배당은 원래 주는 회사만 있다. 나머지가 거의 비면 매칭이 어긋난 것이다.
    if (k !== 'dps' && withFs > 0 && n < withFs * 0.5) missing.push(k);
  }

  if (missing.length) {
    console.warn(`\n⚠ ${missing.join(', ')} 가 절반도 안 채워졌습니다 — 계정과목명 매칭이 어긋났을 수 있습니다.`);
    const top = [...unknownAccounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
    if (top.length) {
      console.warn('  DART 가 준 이름 중 알아보지 못한 것 (많은 순):');
      for (const [nm, n] of top) console.warn(`    ${String(n).padStart(6)}회  ${nm}`);
      console.warn('  이 목록에서 찾는 항목을 골라 ACCOUNTS 에 추가하세요.');
    }
  }
}

await main();
