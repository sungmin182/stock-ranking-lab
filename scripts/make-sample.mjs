/**
 * 예시 데이터 생성기 — data/stocks.json
 *
 * KRX·DART 는 둘 다 무료지만 **인증키가 있어야** 한다. 키를 발급받기 전에도
 * 화면이 어떻게 도는지 볼 수 있어야 하므로, 같은 모양의 파일을 하나 만든다.
 *
 * ── 회사 이름을 지어낸 이유 ─────────────────────────────
 * 실제 상장사 이름에 지어낸 재무 숫자를 붙이면, 화면을 캡처해서 옮기는 순간
 * "삼성전자 PER 3.2" 같은 거짓 정보가 된다. 배너는 잘려 나가도 이름은 남는다.
 * 그래서 실재하지 않는 회사 이름만 쓰고, 종목코드도 9로 시작하게 두었다.
 *
 * 파일에는 sample: true 가 들어가고, 화면 위쪽에 빨간 띠가 뜬다.
 * 진짜 데이터를 받으면(npm run sync) 이 파일이 덮어써지고 띠도 사라진다.
 */
import { writeJson } from './lib.mjs';

/** 같은 결과가 나오게 고정한 난수 (mulberry32) */
function rng(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260823);

const pickOne = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (lo, hi) => lo + rand() * (hi - lo);
/** 로그 정규 비슷하게 — 시가총액처럼 위쪽으로 길게 늘어지는 값에 쓴다 */
const logBetween = (lo, hi) => Math.exp(between(Math.log(lo), Math.log(hi)));

const HEADS = [
  '가온', '나린', '다온', '라온', '마루', '바로', '새얀', '아라', '자람', '차온',
  '카름', '타래', '파란', '하람', '한빛', '두레', '미르', '누리', '온새', '해솔',
  '별하', '슬기', '여울', '이든', '초록', '푸른', '해든', '늘봄', '보람', '단비',
];
const TAILS = [
  { word: '전자', sector: '전기전자', style: 'growth' },
  { word: '반도체', sector: '전기전자', style: 'growth' },
  { word: '화학', sector: '화학', style: 'value' },
  { word: '케미칼', sector: '화학', style: 'value' },
  { word: '제약', sector: '의약품', style: 'growth' },
  { word: '바이오', sector: '의약품', style: 'loss' },
  { word: '중공업', sector: '기계·장비', style: 'value' },
  { word: '건설', sector: '건설업', style: 'value' },
  { word: '해운', sector: '운수창고업', style: 'value' },
  { word: '항공', sector: '운수창고업', style: 'value' },
  { word: '은행지주', sector: '금융업', style: 'dividend' },
  { word: '증권', sector: '금융업', style: 'dividend' },
  { word: '화재', sector: '금융업', style: 'dividend' },
  { word: '식품', sector: '음식료품', style: 'steady' },
  { word: '유업', sector: '음식료품', style: 'steady' },
  { word: '통신', sector: '통신업', style: 'dividend' },
  { word: '유통', sector: '유통업', style: 'steady' },
  { word: '백화점', sector: '유통업', style: 'steady' },
  { word: '자동차', sector: '운송장비', style: 'value' },
  { word: '모빌리티', sector: '운송장비', style: 'growth' },
  { word: '철강', sector: '철강·금속', style: 'value' },
  { word: '소프트', sector: '서비스업', style: 'growth' },
  { word: '게임즈', sector: '서비스업', style: 'growth' },
  { word: '엔터', sector: '서비스업', style: 'growth' },
  { word: '섬유', sector: '섬유·의복', style: 'value' },
  { word: '전력', sector: '전기가스업', style: 'dividend' },
  { word: '가스', sector: '전기가스업', style: 'dividend' },
  { word: '종이', sector: '종이·목재', style: 'steady' },
];

/** 성격마다 지표의 대략적인 범위를 다르게 준다 — 프리셋이 실제로 갈리도록 */
const STYLE = {
  value: { per: [3, 11], pbr: [0.25, 0.9], roe: [3, 12], divPct: 0.75, growth: [-8, 12] },
  growth: { per: [18, 90], pbr: [2, 9], roe: [8, 28], divPct: 0.25, growth: [10, 60] },
  dividend: { per: [4, 9], pbr: [0.3, 0.8], roe: [6, 14], divPct: 0.95, growth: [-3, 8] },
  steady: { per: [9, 18], pbr: [0.8, 2.2], roe: [7, 16], divPct: 0.7, growth: [0, 12] },
  loss: { per: null, pbr: [1.5, 12], roe: null, divPct: 0.05, growth: [-30, 80] },
};

const MARKETS = ['KOSPI', 'KOSDAQ'];

function makeStock(i) {
  // 업종이 골고루 나오도록 꼬리(업종)를 빨리 돌리고 머리(이름)를 천천히 돌린다
  const tail = TAILS[i % TAILS.length];
  const head = HEADS[Math.floor(i / TAILS.length) % HEADS.length];
  const cycle = Math.floor(i / (TAILS.length * HEADS.length));
  const name = `${head}${tail.word}${cycle ? cycle + 1 : ''}`;
  const style = STYLE[tail.style];

  const market = tail.sector === '금융업' || tail.sector === '전기가스업' ? 'KOSPI' : pickOne(MARKETS);
  const cap = Math.round(logBetween(3e10, market === 'KOSPI' ? 4e13 : 3e12));
  const close = Math.round(logBetween(1200, 240000) / 10) * 10;
  const shares = Math.max(1, Math.round(cap / close));

  // 재무는 지표에서 거꾸로 만든다 — 그래야 화면의 계산 근거가 서로 맞는다
  const pbr = between(...style.pbr);
  const equity = Math.round(cap / pbr);
  const loss = style.per == null;
  const per = loss ? null : between(...style.per);
  const netIncome = loss ? -Math.round(equity * between(0.02, 0.25)) : Math.round(cap / per);
  const revenue = Math.round(equity * between(0.5, 2.6));
  const operatingIncome = Math.round(netIncome * between(1.0, 1.6));
  const liabilities = Math.round(equity * between(0.2, 2.4));

  const revGrowthPct = between(...style.growth);
  const prevRevenue = Math.round(revenue / (1 + revGrowthPct / 100));
  const prevNetIncome = netIncome > 0 ? Math.round(netIncome / (1 + between(-0.3, 0.6))) : null;

  // 배당 — 성격에 따라 주는 회사 비율이 다르다
  const paysDiv = rand() < style.divPct && netIncome > 0;
  const dps = paysDiv ? Math.round((close * between(0.005, 0.075)) / 10) * 10 : null;

  const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
  const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

  return {
    code: `9${String(i).padStart(5, '0')}`,
    name,
    market,
    sector: tail.sector,
    kind: '보통주',
    listedOn: `${1988 + Math.floor(rand() * 36)}-0${1 + Math.floor(rand() * 9)}-1${Math.floor(rand() * 9)}`,

    close,
    change: Math.round((close * between(-0.06, 0.06)) / 10) * 10,
    changePct: round2(between(-6, 6)),
    high: Math.round(close * 1.02),
    low: Math.round(close * 0.98),
    volume: Math.round(logBetween(3000, 9e6)),
    value: Math.round(logBetween(1e8, 4e11)),
    cap,
    capRank: 0,
    shares,
    // 기간이 길수록 흔들림도 커지게 둔다 — 1일과 5년이 같은 폭이면 어색하다
    ret: {
      7: round1(between(-7, 8)),
      30: round1(between(-22, 26)),
      90: round1(between(-38, 55)),
      180: round1(between(-45, 80)),
      365: round1(between(-55, 130)),
      1825: round1(between(-80, 400)),
    },

    fin: {
      year: 2025,
      fs: 'CFS',
      revenue,
      operatingIncome,
      netIncome,
      assets: equity + liabilities,
      liabilities,
      equity,
      dps,
    },

    per: netIncome > 0 ? round2(cap / netIncome) : null,
    pbr: round2(pbr),
    psr: round2(cap / revenue),
    roe: netIncome > 0 ? round2((netIncome / equity) * 100) : round2((netIncome / equity) * 100),
    opm: round2((operatingIncome / revenue) * 100),
    debt: round1((liabilities / equity) * 100),
    divYield: dps ? round2((dps / close) * 100) : null,
    payout: dps && netIncome > 0 ? round1(((dps * shares) / netIncome) * 100) : null,
    revGrowth: round1(revGrowthPct),
    profitGrowth: prevNetIncome ? round1(((netIncome - prevNetIncome) / prevNetIncome) * 100) : null,
  };
}

const stocks = Array.from({ length: 420 }, (_, i) => makeStock(i));
stocks.sort((a, b) => b.cap - a.cap);
stocks.forEach((s, i) => (s.capRank = i + 1));

const sectors = {};
for (const s of stocks) sectors[s.sector] = (sectors[s.sector] ?? 0) + 1;

await writeJson('data/stocks.json', {
  sample: true,
  date: new Date().toISOString().slice(0, 10),
  finYear: 2025,
  sources: ['예시 데이터 (scripts/make-sample.mjs 가 지어낸 값)'],
  count: stocks.length,
  sectors,
  stocks,
});

/* ── 차트용 과거 종가 ──────────────────────────────────────
 * 실물(sync-history.mjs)과 같은 모양으로 만든다 — 오래된 쪽은 월 단위,
 * 최근 반년은 주 단위로 촘촘하게. 값은 오늘 종가에서 거꾸로 걸어간
 * 임의 보행이라, 선이 자연스럽게 흔들리면서 끝점은 시세와 맞는다.
 */
const WEEKLY_WEEKS = 26;
const MONTHLY_MONTHS = 54;

const backDays = (() => {
  const days = new Set();
  for (let w = 0; w <= WEEKLY_WEEKS; w++) days.add(w * 7);
  const firstMonth = Math.ceil((WEEKLY_WEEKS * 7) / 30) + 1;
  for (let m = firstMonth; m < firstMonth + MONTHLY_MONTHS; m++) days.add(m * 30);
  return [...days].sort((a, b) => b - a);
})();

const today = new Date();
const dates = backDays.map((b) => {
  const d = new Date(today);
  d.setDate(d.getDate() - b);
  return d.toISOString().slice(0, 10);
});

const history = {};
for (const s of stocks) {
  // 끝(오늘)에서 시작해 과거로 거슬러 올라가며 흔든 뒤 뒤집는다
  const back = [s.close];
  for (let i = 1; i < dates.length; i++) {
    const step = 1 + between(-0.07, 0.07);
    back.push(Math.max(50, Math.round((back[i - 1] / step) / 10) * 10));
  }
  history[s.code] = back.reverse();
}

await writeJson('data/history.json', {
  sample: true,
  source: '예시 데이터 (scripts/make-sample.mjs 가 지어낸 값)',
  note: '수정주가가 아닙니다 — 액면분할·병합은 보정되지 않았습니다',
  dates,
  count: Object.keys(history).length,
  stocks: history,
});

console.log(
  [
    `data/stocks.json — 예시 ${stocks.length}종목`,
    `data/history.json — 예시 ${Object.keys(history).length}종목 × ${dates.length}지점 (${dates[0]} ~ ${dates[dates.length - 1]})`,
    '',
    '⚠ 실재하지 않는 회사와 지어낸 숫자입니다. 화면 위에 경고 띠가 뜹니다.',
    '  진짜 데이터를 받으려면 KRX_API_KEY / DART_API_KEY 를 넣고 npm run sync 하세요.',
  ].join('\n'),
);
