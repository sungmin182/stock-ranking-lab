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
 * 엔드포인트·정규화·오류 해석은 krx.mjs 에 모아 두었다.
 * 차트용 과거 시세(sync-history.mjs)가 같은 캐시를 쓰기 때문이다.
 *
 * ── 왜 과거 스냅샷을 따로 받나 ──────────────────────────
 * "최근 3개월 수익률" 같은 지표를 쓰려면 그 시점의 종가가 있어야 하는데
 * 일별매매정보 API 는 하루치만 준다. 그래서 되돌아볼 날짜를 각각 받아
 * 캐시에 쌓아 둔다. 과거 날짜의 값은 바뀌지 않으므로 한 번 받으면 다시
 * 받지 않는다. 보드게임 쪽에서 BGG 랭킹 스냅샷을 모아 두던 것과 같다.
 */
import { get, writeJson, ymd, daysAgo, sleep } from './lib.mjs';
import {
  BASE,
  KEY,
  MARKETS,
  requireKey,
  fetchNearestTradingDay,
  normalizeTrade,
  normalizeInfo,
  dumpKeys,
  explain,
} from './krx.mjs';

/**
 * 수익률에 쓸 되돌아볼 일수.
 *
 * 1일치는 여기 넣지 않는다. KRX 가 당일 등락률(FLUC_RT)을 이미 주기 때문에
 * 전 거래일을 따로 받을 이유가 없다 — 화면의 '1일' 은 그 값을 쓴다.
 *
 * 과거 날짜의 시세는 한 번 받으면 바뀌지 않아 cache/prices 에 남는다.
 * 그래서 되돌아볼 지점을 늘려도 첫 실행만 느리고 그다음부터는 공짜다.
 */
const LOOKBACKS = [7, 30, 90, 180, 365, 1825];

requireKey();

async function main() {
  const today = new Map();
  const info = new Map();
  let baseDate = null;

  /*
   * 시장 하나가 막혀도 나머지는 받는다.
   *
   * KRX 는 API 별로 사용 승인이 따로 나기 때문에, 코스피는 승인됐는데 코넥스는
   * 아직인 상태가 실제로 생긴다. 그때 전체를 죽이면 다 승인될 때까지 아무것도
   * 못 본다. 코넥스는 종목 수도 얼마 안 되므로 없어도 사이트는 멀쩡하다.
   * 단 하나도 못 받았을 때만 실패한다.
   */
  const skipped = [];

  for (const market of MARKETS) {
    console.log(`${market.id} 최근 거래일 시세…`);
    let dd;
    let rows;
    try {
      ({ dd, rows } = await fetchNearestTradingDay(market, new Date()));
    } catch (err) {
      console.warn(`  건너뜀 — ${explain(err)}`);
      skipped.push(market.id);
      continue;
    }
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
      console.warn(`  기본정보 건너뜀 — ${explain(err)}`);
    }
    await sleep(200);
  }

  if (!today.size) {
    console.error(
      [
        '',
        '시세를 한 종목도 받지 못했습니다.',
        `막힌 시장: ${skipped.join(', ') || '(없음)'}`,
        '',
        'KRX 는 인증키 발급과 API 별 사용 승인이 따로입니다.',
        'openapi.krx.co.kr 에 로그인해 아래 서비스가 "승인" 상태인지 확인하세요.',
        '  · 유가증권 일별매매정보 (stk_bydd_trd)',
        '  · 코스닥 일별매매정보 (ksq_bydd_trd)',
        '  · 종목기본정보 (stk_isu_base_info / ksq_isu_base_info)',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
  if (skipped.length) console.log(`\n건너뛴 시장: ${skipped.join(', ')} — 나머지로 진행합니다\n`);

  // ── 과거 스냅샷 ────────────────────────────────────────
  const history = {};
  for (const back of LOOKBACKS) {
    const target = daysAgo(back);
    console.log(`${back}일 전(${ymd(target)}) 스냅샷…`);
    const snap = new Map();
    for (const market of MARKETS) {
      // 오늘 것도 못 받은 시장은 과거도 못 받는다. 401 을 더 맞을 이유가 없다.
      if (skipped.includes(market.id)) continue;
      try {
        const { rows } = await fetchNearestTradingDay(market, target);
        for (const raw of rows) {
          const r = normalizeTrade(raw, market.id);
          if (r.code && r.close) snap.set(r.code, r.close);
        }
      } catch (err) {
        console.warn(`  ${market.id} 건너뜀 — ${explain(err)}`);
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
