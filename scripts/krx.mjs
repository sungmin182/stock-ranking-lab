/**
 * KRX 오픈API 공용 부분.
 *
 *   출처  http://data-dbg.krx.co.kr/svc/apis/...
 *   인증  요청 헤더 AUTH_KEY (openapi.krx.co.kr 에서 무료 발급)
 *
 * sync-prices.mjs(최근 시세)와 sync-history.mjs(차트용 과거 시세)가 같은
 * 엔드포인트를 같은 캐시로 읽는다. 캐시가 날짜별 파일이라, 두 스크립트가
 * 겹치는 날짜를 요청해도 두 번 받지 않는다.
 */
import path from 'node:path';
import { get, readJson, writeJson, ymd8, daysAgo, lastWeekday, num, sleep } from './lib.mjs';

export const KEY = process.env.KRX_API_KEY;
export const BASE = 'http://data-dbg.krx.co.kr/svc/apis';
export const CACHE = 'cache/prices';

/** 시장별 일별매매정보 / 종목기본정보 엔드포인트 */
export const MARKETS = [
  { id: 'KOSPI', path: 'sto/stk_bydd_trd', info: 'sto/stk_isu_base_info' },
  { id: 'KOSDAQ', path: 'sto/ksq_bydd_trd', info: 'sto/ksq_isu_base_info' },
  { id: 'KONEX', path: 'sto/knx_bydd_trd', info: 'sto/knx_isu_base_info' },
];

export function requireKey(script = 'npm run sync') {
  if (KEY) return;
  console.error(
    [
      '',
      'KRX_API_KEY 가 없습니다.',
      '',
      '  1. https://openapi.krx.co.kr 에서 무료 가입 후 인증키를 발급받으세요.',
      '  2. 쓸 API 마다 "활용 신청" 을 따로 해야 합니다 (인증키 발급과 별개 절차입니다).',
      '  3. 발급된 키를 환경변수로 넣고 다시 실행하세요.',
      '',
      `     PowerShell:  $env:KRX_API_KEY = "발급받은키"; ${script}`,
      `     bash:        KRX_API_KEY=발급받은키 ${script}`,
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
export async function fetchDay(market, dd) {
  const json = await get(`${BASE}/${market.path}?basDd=${dd}`, { headers: { AUTH_KEY: KEY } });
  return json.OutBlock_1 ?? json.outBlock_1 ?? json.OutBlock ?? [];
}

/**
 * 그 날짜가 휴장일이면 하루씩 뒤로 물러나며 값이 나오는 날을 찾는다.
 * 설·추석 연휴가 닷새까지 가므로 최대 10일까지 본다.
 */
export async function fetchNearestTradingDay(market, from, { quiet = false } = {}) {
  let d = lastWeekday(from);
  for (let back = 0; back < 10; back++) {
    const dd = ymd8(d);
    const cached = await readJson(path.join(CACHE, `${market.id}-${dd}.json`));
    if (cached) {
      // fromCache 는 부르는 쪽이 "이번 실행에서 실제로 몇 번 KRX 를 때렸는지"
      // 세는 데 쓴다. 호출량 제한이 있어 한 번에 다 받으려 하면 403 이 난다.
      if (cached.length) return { dd, rows: cached, fromCache: true };
    } else {
      const rows = await fetchDay(market, dd);
      await writeJson(path.join(CACHE, `${market.id}-${dd}.json`), rows);
      if (rows.length) return { dd, rows, fromCache: false };
      if (!quiet) console.log(`  ${dd} 휴장 — 하루 앞으로`);
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
export const pick = (row, ...names) => {
  for (const n of names) if (row[n] != null) return row[n];
  return null;
};

export const codeOf = (row) =>
  String(pick(row, 'ISU_SRT_CD', 'ISU_CD', 'isuSrtCd') ?? '')
    .trim()
    .replace(/^A/, '')
    .padStart(6, '0');

export function normalizeTrade(row, marketId) {
  return {
    code: codeOf(row),
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

export function normalizeInfo(row) {
  return {
    code: codeOf(row),
    listedOn: String(pick(row, 'LIST_DD') ?? '').trim() || null,
    // '보통주' / '우선주'. 우선주는 기본 화면에서 걸러낼 수 있게 따로 들고 간다.
    kind: String(pick(row, 'KIND_STKCERT_TP_NM') ?? '').trim() || null,
    group: String(pick(row, 'SECUGRP_NM') ?? '').trim() || null,
    sector: String(pick(row, 'SECT_TP_NM') ?? '').trim() || null,
  };
}

/** 실제 필드명을 한 번 찍어 준다. 문서와 다를 때 대조용. */
export function dumpKeys(label, rows) {
  if (!rows.length || !process.env.DUMP) return;
  console.log(`\n[${label}] 필드명:`, Object.keys(rows[0]).join(', '));
  console.log(`[${label}] 첫 줄:`, JSON.stringify(rows[0]).slice(0, 400), '\n');
}

/**
 * 오류를 사람이 읽을 수 있는 한 줄로 바꾼다.
 *
 * KRX 는 401 을 두 가지 뜻으로 쓴다. 둘을 구별해 주지 않으면 "키를 넣었는데
 * 왜 401 이냐"에서 한참 헤맨다. 실제로 여기서 헤맸다.
 *
 *   Unauthorized Key       키 자체가 없거나 틀렸다
 *   Unauthorized API Call  키는 맞는데 이 API 를 쓸 권한이 그 키에 없다
 *                          (KRX 는 인증키 발급과 API 별 사용 승인이 따로다)
 */
export function explain(err) {
  const body = err.body ?? '';
  if (err.status === 401 && body.includes('Unauthorized API Call')) {
    return '이 API 를 쓸 권한이 인증키에 없습니다 — openapi.krx.co.kr 에서 해당 서비스 사용 신청이 승인됐는지 확인하세요 (인증키 발급과 별개입니다)';
  }
  if (err.status === 401) return '인증키가 없거나 틀렸습니다 (KRX_API_KEY 확인)';
  /*
   * 403 은 권한이 아니라 호출량 문제로 보인다. 한 번에 200번 넘게 부르니
   * 성공과 403 이 뒤섞여 나왔고, 잠시 쉬었다 부르면 다시 받아졌다.
   * 재시도는 lib.mjs 의 get() 이 알아서 하고, 그래도 안 되면 여기까지 온다.
   */
  if (err.status === 403) return '호출이 몰려 KRX 가 거절했습니다(403) — 다음 실행에서 이어 받습니다';
  return err.message.split('\n')[0];
}

/** 401(권한 없음)처럼 다시 시도해도 소용없는 오류인가 */
export const isPermanent = (err) => err.status === 401;
