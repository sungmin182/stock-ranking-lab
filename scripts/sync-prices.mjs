/**
 * KRX 오픈API — 전종목 일별 시세 수집
 *
 *   출처  http://data-dbg.krx.co.kr/svc/apis/sto/...
 *   인증  요청 헤더 AUTH_KEY (openapi.krx.co.kr 에서 무료 발급)
 *
 * 세 시장(유가증권·코스닥·코넥스)의 일별매매정보와 종목기본정보를 받아
 *   data/prices.json      ← 최근 거래일 시세 + 과거 스냅샷에서 계산한 수익률
 *   cache/prices/*.json   ← 날짜별 원본 (다음 실행에서 재사용)
 * 를 만든다.
 *
 * ── 왜 과거 스냅샷을 따로 받나 ──────────────────────────
 * "최근 3개월 수익률" 같은 지표를 쓰려면 그 시점의 종가가 있어야 하는데
 * 일별매매정보 API 는 하루치만 준다. 그래서 1개월·3개월·1년 전 날짜를 각각
 * 받아 캐시에 쌓아 둔다. 과거 날짜의 값은 바뀌지 않으므로 한 번 받으면
 * 다시 받지 않는다. 보드게임 쪽에서 BGG 랭킹 스냅샷을 모아 두던 것과 같다.
 */
import path from 'node:path';
import { get, readJson, writeJson, ymd, ymd8, daysAgo, lastWeekday, num, sleep } from './lib.mjs';

const KEY = process.env.KRX_API_KEY;
const BASE = 'http://data-dbg.krx.co.kr/svc/apis/sto';
const CACHE = 'cache/prices';

/** 시장별 일별매매정보 / 종목기본정보 엔드포인트 */
const MARKETS = [
  { id: 'KOSPI', path: 'stk_bydd_trd', info: 'stk_isu_base_info' },
  { id: 'KOSDAQ', path: 'ksq_bydd_trd', info: 'ksq_isu_base_info' },
  { id: 'KONEX', path: 'knx_bydd_trd', info: 'knx_isu_base_info' },
];

/** 수익률에 쓸 되돌아볼 일수 */
const LOOKBACKS = [30, 90, 365];

if (!KEY) {
  console.error(
    [
      '',
      'KRX_API_KEY 가 없습니다.',
      '',
      '  1. https://openapi.krx.co.kr 에서 무료 가입 후 인증키를 발급받으세요.',
      '  2. 발급된 키를 환경변수로 넣고 다시 실행하세요.',
      '',
      '     PowerShell:  $env:KRX_API_KEY = "발급받은키"; npm run sync',
      '     bash:        KRX_API_KEY=발급받은키 npm run sync',
      '',
      '키 없이 화면부터 보고 싶다면:  npm run sample',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

/**
 * 한 시장의 하루치를 받는다.
 * 휴장일이면 OutBlock_1 이 빈 배열로 온다 — 그것으로 거래일 여부를 판별한다.
 */
async function fetchDay(market, dd) {
  const url = `${BASE}/${market.path}?basDd=${dd}`;
  const json = await get(url, { headers: { AUTH_KEY: KEY } });
  return json.OutBlock_1 ?? json.outBlock_1 ?? json.OutBlock ?? [];
}

/**
 * 그 날짜가 휴장일이면 하루씩 뒤로 물러나며 값이 나오는 날을 찾는다.
 * 설·추석 연휴가 닷새까지 가므로 최대 10일까지 본다.
 */
async function fetchNearestTradingDay(market, from) {
  let d = lastWeekday(from);
  for (let back = 0; back < 10; back++) {
    const dd = ymd8(d);
    const cached = await readJson(path.join(CACHE, `${market.id}-${dd}.json`));
    if (cached) {
      if (cached.length) return { dd, rows: cached };
    } else {
      const rows = await fetchDay(market, dd);
      await writeJson(path.join(CACHE, `${market.id}-${dd}.json`), rows);
      if (rows.length) return { dd, rows };
      console.log(`  ${dd} 휴장 — 하루 앞으로`);
      await sleep(120);
    }
    d = daysAgo(1, d);
  }
  throw new Error(`${market.id}: ${ymd8(from)} 앞뒤로 거래일을 찾지 못했습니다`);
}

/**
 * 필드명 후보를 나열해 두고 먼저 잡히는 것을 쓴다.
 * KRX 가 이름을 바꿔도 여기 한 줄만 고치면 된다.
 * DUMP=1 로 실행하면 실제 필드명을 찍어 주므로 대조할 수 있다.
 */
const pick = (row, ...names) => {
  for (const n of names) if (row[n] != null) return row[n];
  return null;
};

function normalizeTrade(row, marketId) {
  const code = String(pick(row, 'ISU_SRT_CD', 'ISU_CD', 'isuSrtCd') ?? '').trim();
  return {
    code: code.replace(/^A/, '').padStart(6, '0'),
    name: String(pick(row, 'ISU_NM', 'ISU_ABBRV', 'isuNm') ?? '').trim(),
    market: String(pick(row, 'MKT_NM') ?? marketId).trim() || marketId,
    sector: String(pick(row, 'SECT_TP_NM', 'IDX_IND_NM') ?? '').trim() || null,
    close: num(pick(row, 'TDD_CLSPRC')),
    change: num(pick(row, 'CMPPREVDD_PRC')),
    changePct: num(pick(row, 'FLUC_RT')),
    open: num(pick(row, 'TDD_OPNPRC')),
    high: num(pick(row, 'TDD_HGPRC')),
    low: num(pick(row, 'TDD_LWPRC')),
    volume: num(pick(row, 'ACC_TRDVOL')),
    value: num(pick(row, 'ACC_TRDVAL')),
    cap: num(pick(row, 'MKTCAP')),
    shares: num(pick(row, 'LIST_SHRS')),
  };
}

function normalizeInfo(row) {
  const code = String(pick(row, 'ISU_SRT_CD', 'ISU_CD') ?? '').trim();
  return {
    code: code.replace(/^A/, '').padStart(6, '0'),
    listedOn: String(pick(row, 'LIST_DD') ?? '').trim() || null,
    // '보통주' / '우선주'. 우선주는 기본 화면에서 걸러낼 수 있게 따로 들고 간다.
    kind: String(pick(row, 'KIND_STKCERT_TP_NM') ?? '').trim() || null,
    group: String(pick(row, 'SECUGRP_NM') ?? '').trim() || null,
    sector: String(pick(row, 'SECT_TP_NM') ?? '').trim() || null,
  };
}

/** 실제 필드명을 한 번 찍어 준다. 문서와 다를 때 대조용. */
function dumpKeys(label, rows) {
  if (!rows.length || !process.env.DUMP) return;
  console.log(`\n[${label}] 필드명:`, Object.keys(rows[0]).join(', '));
  console.log(`[${label}] 첫 줄:`, JSON.stringify(rows[0]).slice(0, 400), '\n');
}

async function main() {
  const today = new Map();
  const info = new Map();
  let baseDate = null;

  for (const market of MARKETS) {
    console.log(`${market.id} 최근 거래일 시세…`);
    const { dd, rows } = await fetchNearestTradingDay(market, new Date());
    dumpKeys(`${market.id} 시세`, rows);
    baseDate ??= dd;
    for (const raw of rows) {
      const r = normalizeTrade(raw, market.id);
      if (r.code) today.set(r.code, r);
    }
    console.log(`  ${dd} · ${rows.length.toLocaleString('ko-KR')}종목`);

    // 종목기본정보는 상장일·우선주 여부 때문에 받는다. 매일 바뀌지 않는다.
    try {
      const res = await get(`${BASE}/${market.info}?basDd=${dd}`, { headers: { AUTH_KEY: KEY } });
      const list = res.OutBlock_1 ?? [];
      dumpKeys(`${market.id} 기본정보`, list);
      for (const raw of list) {
        const r = normalizeInfo(raw);
        if (r.code) info.set(r.code, r);
      }
      console.log(`  기본정보 ${list.length.toLocaleString('ko-KR')}건`);
    } catch (err) {
      console.warn(`  기본정보 실패(건너뜀): ${err.message.split('\n')[0]}`);
    }
    await sleep(200);
  }

  // ── 과거 스냅샷 ────────────────────────────────────────
  const history = {};
  for (const back of LOOKBACKS) {
    const target = daysAgo(back);
    console.log(`${back}일 전(${ymd(target)}) 스냅샷…`);
    const snap = new Map();
    for (const market of MARKETS) {
      try {
        const { rows } = await fetchNearestTradingDay(market, target);
        for (const raw of rows) {
          const r = normalizeTrade(raw, market.id);
          if (r.code && r.close) snap.set(r.code, r.close);
        }
      } catch (err) {
        console.warn(`  ${market.id} 건너뜀: ${err.message.split('\n')[0]}`);
      }
      await sleep(200);
    }
    history[back] = snap;
    console.log(`  ${snap.size.toLocaleString('ko-KR')}종목`);
  }

  const stocks = [];
  for (const [code, r] of today) {
    const meta = info.get(code);
    const ret = {};
    for (const back of LOOKBACKS) {
      const then = history[back]?.get(code);
      /*
       * 등락률(%)로 저장한다. 액면분할·병합·유상증자는 보정하지 않는다 —
       * 원자료에 수정주가가 없기 때문이다. 분할한 종목은 그 기간 수익률이
       * 실제와 다르게 나오므로 화면에서도 참고값으로만 쓴다.
       */
      if (then && r.close) ret[back] = Math.round(((r.close - then) / then) * 1000) / 10;
    }
    stocks.push({ ...r, ...(meta ?? {}), ret });
  }

  stocks.sort((a, b) => (b.cap ?? 0) - (a.cap ?? 0));
  stocks.forEach((s, i) => (s.capRank = i + 1));

  await writeJson('data/prices.json', {
    date: `${baseDate.slice(0, 4)}-${baseDate.slice(4, 6)}-${baseDate.slice(6)}`,
    source: 'KRX 오픈API (data-dbg.krx.co.kr)',
    count: stocks.length,
    stocks,
  });
  console.log(`\ndata/prices.json — ${stocks.length.toLocaleString('ko-KR')}종목 (기준일 ${baseDate})`);
}

await main();
