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

/** 계정과목명 → 우리가 쓰는 이름 */
const ACCOUNTS = {
  자산총계: 'assets',
  부채총계: 'liabilities',
  자본총계: 'equity',
  매출액: 'revenue',
  영업이익: 'operatingIncome',
  당기순이익: 'netIncome',
};

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
  const res = await get(url);
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
  for (const r of rows) {
    if (r.fs_div !== preferred) continue;
    const key = ACCOUNTS[String(r.account_nm ?? '').replace(/\s/g, '')];
    if (!key) continue;
    out.fs = preferred;
    out[key] = num(r.thstrm_amount);
    // 전기 값은 성장률 계산에 쓴다
    const prev = num(r.frmtrm_amount);
    if (prev != null) out[`prev_${key}`] = prev;
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
  const res = await get(url).catch(() => null);
  if (!res || res.status !== '000') return null;

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

  const cacheFile = path.join(CACHE, `fin-${year}.json`);
  const cache = (await readJson(cacheFile)) ?? {};
  const fresh = (code) => cache[code] && Date.now() - cache[code].at < TTL_MS;

  // ── 재무제표: 100개씩 묶어서 ────────────────────────────
  const stale = targets.filter((t) => !fresh(t.code));
  console.log(`재무제표 ${stale.length.toLocaleString('ko-KR')}종목 갱신 (캐시 ${(targets.length - stale.length).toLocaleString('ko-KR')})`);

  const batches = [];
  for (let i = 0; i < stale.length; i += 100) batches.push(stale.slice(i, i + 100));

  let done = 0;
  for (const batch of batches) {
    const rows = await fetchAccounts(batch.map((t) => t.corp), year);
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
    await sleep(150);
  }
  if (batches.length) process.stdout.write('\n');
  await writeJson(cacheFile, cache);

  // ── 배당: 회사마다 한 번씩 ──────────────────────────────
  const divCacheFile = path.join(CACHE, `div-${year}.json`);
  const divCache = (await readJson(divCacheFile)) ?? {};
  const divStale = targets.filter((t) => !(divCache[t.code] && Date.now() - divCache[t.code].at < TTL_MS));
  console.log(`배당 ${divStale.length.toLocaleString('ko-KR')}종목 갱신 (캐시 ${(targets.length - divStale.length).toLocaleString('ko-KR')})`);

  let dDone = 0;
  await pool(divStale, CONCURRENCY, async (t) => {
    const dps = await fetchDividend(t.corp, year);
    divCache[t.code] = { at: Date.now(), dps };
    dDone++;
    if (dDone % 50 === 0) {
      process.stdout.write(`\r  ${dDone.toLocaleString('ko-KR')} / ${divStale.length.toLocaleString('ko-KR')}`);
      // 중간에 끊겨도 여기까지는 남는다
      await writeJson(divCacheFile, divCache);
    }
  });
  if (divStale.length) process.stdout.write('\n');
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
}

await main();
