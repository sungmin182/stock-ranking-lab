/**
 * KRX 오픈API — 차트용 과거 종가 수집
 *
 * 종목마다 주가 흐름을 그리려면 시계열이 있어야 하는데, 일별매매정보 API 는
 * 하루치만 준다. 그래서 여러 날짜를 각각 받아 종목별 배열로 엮는다.
 *
 *   data/history.json      ← { dates: [...], stocks: { '005930': [70000, ...] } }
 *   cache/prices/*.json    ← sync-prices.mjs 와 같은 캐시를 쓴다
 *
 * ── 왜 매일이 아니라 띄엄띄엄 받나 ──────────────────────
 * 5년치 매일이면 1,200 거래일 × 시장 수만큼 호출해야 하고, 결과 파일도
 * 2,700종목 × 1,200점이라 수십 MB가 된다. 차트 한 장에 그렇게까지 필요없다.
 *
 * 대신 최근일수록 촘촘하게 잡는다. 사람이 궁금해하는 것은 "요즘 어떤가"이고
 * 5년 전은 대략의 모양만 알면 되기 때문이다.
 *
 *   최근 26주   주 1회   (반년치를 주 단위로)
 *   그 이전 5년  월 1회   (긴 흐름)
 *
 * 합쳐 약 85개 지점. 종목당 85개 숫자면 파일이 1~2MB라 화면에서 감당된다.
 * 과거 날짜의 값은 바뀌지 않으므로 한 번 받으면 캐시에서 꺼내 쓴다.
 *
 * ⚠ 수정주가가 아니다. 액면분할·병합이 있었던 종목은 그 시점에서 선이
 *   뚝 끊긴 것처럼 보인다. 원자료에 수정주가가 없어 보정할 방법이 없다.
 *   화면에도 그렇게 적어 두었다.
 */
import { writeJson, ymd, ymd8, daysAgo, sleep } from './lib.mjs';
import { MARKETS, requireKey, fetchNearestTradingDay, codeOf, pick, explain, isPermanent } from './krx.mjs';
import { num } from './lib.mjs';

/** 최근 몇 주를 주 단위로 볼지 */
const WEEKLY_WEEKS = 26;
/** 그 이전 몇 개월을 월 단위로 볼지 */
const MONTHLY_MONTHS = 54;

/*
 * 한 번에 새로 받을 수 있는 지점 수와 호출 사이 간격.
 *
 * KRX 는 호출이 몰리면 403 을 돌려준다. 81지점 × 시장 3개를 한 번에 받으려다
 * 실제로 맞았다. 캐시가 날짜별이라 진도는 실행을 거듭하며 저절로 쌓이므로,
 * 한 실행에서 무리하지 않고 조금씩 받는 편이 결국 빠르다.
 *
 * 평일 저녁마다 도니 며칠이면 5년치가 다 찬다. 그 뒤로는 새 지점이 한 주에
 * 하나씩만 생기므로 늘 캐시에서 나온다.
 */
const MAX_NEW_FETCHES = Number(process.env.MAX_NEW_FETCHES ?? 60);
const PACE_MS = Number(process.env.PACE_MS ?? 700);

requireKey('npm run sync:history');

/** 오래된 것부터 오늘까지, 되돌아볼 일수 목록 */
function lookbackDays() {
  const days = new Set();
  for (let w = 0; w <= WEEKLY_WEEKS; w++) days.add(w * 7);
  // 주 단위 구간이 끝나는 달의 다음 달부터 월 단위로 이어 붙인다
  const firstMonth = Math.ceil((WEEKLY_WEEKS * 7) / 30) + 1;
  for (let m = firstMonth; m < firstMonth + MONTHLY_MONTHS; m++) days.add(m * 30);
  return [...days].sort((a, b) => b - a); // 오래된 것부터
}

async function main() {
  const days = lookbackDays();
  console.log(`지점 ${days.length}개 (최근 ${WEEKLY_WEEKS}주는 주 단위, 그 이전 ${MONTHLY_MONTHS}개월은 월 단위)`);

  const dates = [];
  /** code → 지점별 종가 (빠진 날은 null) */
  const series = new Map();
  const skipped = new Set();

  let fetched = 0; // 이번 실행에서 실제로 KRX 를 때린 횟수
  let quotaHit = false;

  for (const [i, back] of days.entries()) {
    const target = daysAgo(back);
    const snap = new Map();
    let label = null;

    for (const market of MARKETS) {
      if (skipped.has(market.id)) continue;
      if (fetched >= MAX_NEW_FETCHES) continue; // 캐시에 있는 것만 마저 훑는다
      try {
        const { dd, rows, fromCache } = await fetchNearestTradingDay(market, target, { quiet: true });
        if (!fromCache) fetched++;
        label ??= dd;
        for (const raw of rows) {
          const code = codeOf(raw);
          const close = num(pick(raw, 'TDD_CLSPRC'));
          if (code && close) snap.set(code, close);
        }
        if (!fromCache) await sleep(PACE_MS);
      } catch (err) {
        /*
         * 401(권한 없음)은 다시 물어도 같은 답이라 그 시장은 접는다 — 코넥스처럼
         * 승인 안 된 시장에서 81번을 헛돌 이유가 없다.
         *
         * 403 은 다르다. 호출이 몰렸다는 뜻이라 다음 실행에서는 받아진다.
         * 전에는 이것도 시장 전체를 접는 데 썼더니, 첫 지점에서 403 한 번 맞고
         * 81지점을 통째로 날렸다. 이제는 그 지점만 건너뛴다.
         */
        if (isPermanent(err)) {
          console.warn(`  ${market.id} 이후 건너뜀 — ${explain(err)}`);
          skipped.add(market.id);
        } else {
          if (!quotaHit) console.warn(`\n  ${explain(err)}`);
          quotaHit = true;
        }
      }
    }

    if (!snap.size) continue;
    dates.push(label ? `${label.slice(0, 4)}-${label.slice(4, 6)}-${label.slice(6)}` : ymd(target));
    const at = dates.length - 1;
    for (const [code, close] of snap) {
      if (!series.has(code)) series.set(code, []);
      const arr = series.get(code);
      while (arr.length < at) arr.push(null); // 아직 상장 전이면 앞이 빈다
      arr[at] = close;
    }
    if ((i + 1) % 10 === 0 || i === days.length - 1) {
      process.stdout.write(`\r  ${dates.length} / ${days.length} 지점 · ${series.size.toLocaleString('ko-KR')}종목`);
    }
  }
  process.stdout.write('\n');

  if (!dates.length) {
    console.error('과거 시세를 한 지점도 받지 못했습니다. KRX 인증키와 API 활용 승인을 확인하세요.');
    process.exit(1);
  }

  // 길이를 맞춘다. 중간에 상장폐지된 종목은 뒤가 빈다.
  const stocks = {};
  for (const [code, arr] of series) {
    while (arr.length < dates.length) arr.push(null);
    // 값이 두 개도 안 되면 선을 그릴 수 없다
    if (arr.filter((v) => v != null).length >= 2) stocks[code] = arr;
  }

  await writeJson('data/history.json', {
    source: 'KRX 오픈API (data-dbg.krx.co.kr)',
    note: '수정주가가 아닙니다 — 액면분할·병합은 보정되지 않았습니다',
    dates,
    count: Object.keys(stocks).length,
    stocks,
  });

  if (quotaHit || fetched >= MAX_NEW_FETCHES) {
    console.log(
      `이번 실행에서 새로 받은 지점 ${fetched}개 · 아직 ${days.length - dates.length}개 남음 — 다음 실행에서 이어 받습니다`,
    );
  }
  console.log(
    `data/history.json — ${Object.keys(stocks).length.toLocaleString('ko-KR')}종목 × ${dates.length}지점 (${dates[0]} ~ ${dates[dates.length - 1]})`,
  );
}

await main();
