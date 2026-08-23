/**
 * 주식 랭킹 랩
 *
 * 설계 요약
 *  - data/stocks.json 을 한 번 읽어 메모리에 올린다.
 *  - 점수 계산에 쓰는 지표는 전부 "백분위(0~1)"로 미리 변환해 둔다.
 *    PER 8배, ROE 14%, 시가총액 3조는 단위가 서로 달라 그대로 더할 수 없고,
 *    백분위는 시가총액 400조짜리 한 종목에 결과가 끌려가지 않는다.
 *  - 필터 → 점수 → 정렬 → 렌더 순서로 흐르고, 상태는 전부 URL과 localStorage에 남는다.
 *
 * 이 파일은 투자 판단을 하지 않는다. 공개 자료를 정렬해 보여줄 뿐이다.
 */

const CONFIG = window.SL_CONFIG ?? {};

/**
 * 배포 번호. 배포 스크립트가 index.html 을 `assets/app.js?v=<번호>` 로 바꾸므로
 * 여기서 그 번호를 되읽을 수 있다. 데이터 주소에도 같은 번호를 붙인다 —
 * 자산에만 붙이면 새 코드가 브라우저에 캐시된 옛 데이터를 읽는다.
 */
const ASSET_VERSION = new URL(import.meta.url).searchParams.get('v');

function versioned(url) {
  if (!ASSET_VERSION) return url;
  return url + (url.includes('?') ? '&' : '?') + 'v=' + ASSET_VERSION;
}

const $ = (sel) => document.querySelector(sel);

const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) if (k != null) node.append(k);
  return node;
};

/**
 * 자식을 통째로 갈아끼운다.
 * replaceChildren 은 null 을 "null" 이라는 글자로 바꿔 넣으므로 여기서 걸러낸다.
 */
const setChildren = (node, ...kids) =>
  node.replaceChildren(...kids.flat().filter((k) => k != null));

/* ── 숫자 표기 ─────────────────────────────────────────────
 * 한국 시장 자료는 자릿수가 커서 원 단위로 그대로 쓰면 읽히지 않는다.
 * 1,234,567,890,000원 보다 1.2조원이 빠르다. */

const nf = (v, digits = 0) =>
  v == null || !Number.isFinite(v)
    ? '–'
    : v.toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** 시가총액·거래대금처럼 큰 금액 */
function money(v) {
  if (v == null || !Number.isFinite(v)) return '–';
  const neg = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1e12) return `${neg}${nf(a / 1e12, 1)}조`;
  if (a >= 1e8) return `${neg}${nf(a / 1e8)}억`;
  if (a >= 1e4) return `${neg}${nf(a / 1e4)}만`;
  return `${neg}${nf(a)}`;
}

const won = (v) => (v == null || !Number.isFinite(v) ? '–' : `${nf(v)}원`);
const pct = (v, digits = 2) => (v == null || !Number.isFinite(v) ? '–' : `${nf(v, digits)}%`);

/** 부호에 따라 색이 붙은 조각. 한국 관례대로 오르면 빨강, 내리면 파랑. */
function signed(v, digits = 2, suffix = '%') {
  if (v == null || !Number.isFinite(v)) return el('span', { className: 'flat', textContent: '–' });
  const cls = v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
  const mark = v > 0 ? '+' : '';
  return el('span', { className: cls, textContent: `${mark}${nf(v, digits)}${suffix}` });
}

/* ── 점수 축 정의 ─────────────────────────────────────────
 * value(s) 는 "클수록 좋다"는 방향으로 맞춘 원시값을 돌려준다.
 * 실제 점수는 이 값들의 백분위에 가중치를 곱해 더한 것이다.
 *
 * 새 축은 반드시 mine 앞, 그러니까 배열 끝에서 두 번째까지에만 끼워 넣는다.
 * URL 의 w 파라미터가 이 순서대로 직렬화되므로 중간에 넣으면 예전에 공유한
 * 링크의 가중치가 한 칸씩 밀린다. */
const AXES = [
  {
    key: 'value',
    label: '저PER',
    note: '이익 대비 싼가. 낮을수록 높은 점수',
    // 로그를 쓰는 이유: PER 5와 10의 차이가 100과 105의 차이보다 크다
    value: (s) => (s.per > 0 ? -Math.log10(s.per) : null),
  },
  {
    key: 'asset',
    label: '저PBR',
    note: '순자산 대비 싼가. 낮을수록 높은 점수',
    value: (s) => (s.pbr > 0 ? -Math.log10(s.pbr) : null),
  },
  {
    key: 'roe',
    label: '수익성',
    note: 'ROE — 자기자본으로 얼마를 벌었나',
    value: (s) => s.roe,
  },
  {
    key: 'divy',
    label: '배당',
    note: '배당수익률. 배당이 없는 회사는 0으로 친다',
    // 재무는 있는데 배당 기록이 없으면 "안 준 것"이다. 재무 자체가 없으면 모르는 것.
    value: (s) => s.divYield ?? (s.fin ? 0 : null),
  },
  {
    key: 'safe',
    label: '안정성',
    note: '부채비율이 낮을수록 높은 점수',
    value: (s) => (s.debt == null ? null : -s.debt),
  },
  {
    key: 'grow',
    label: '성장성',
    note: '매출 증가율(전년 대비)',
    value: (s) => s.revGrowth,
  },
  {
    key: 'mom',
    label: '모멘텀',
    note: '최근 3개월 주가 수익률',
    value: (s) => s.ret?.[90],
  },
  {
    key: 'size',
    label: '규모',
    note: '시가총액(로그). −로 두면 소형주 발굴',
    value: (s) => (s.cap ? Math.log10(s.cap) : null),
  },
  {
    key: 'liq',
    label: '거래활발',
    note: '거래대금(로그). −로 두면 거래가 적은 종목',
    value: (s) => (s.value ? Math.log10(s.value) : null),
  },
  /* 내 평가는 반드시 맨 뒤 (위 주석 참고) */
  {
    key: 'mine',
    label: '내 평가',
    note: '내가 매긴 점수. 기록이 없는 종목은 중간값으로 친다',
    value: (s) => noteOf(s.code)?.rating ?? null,
  },
];

const ZERO = Object.fromEntries(AXES.map((a) => [a.key, 0]));

const PRESETS = {
  '시총순': { ...ZERO, size: 100 },
  '가치주': { ...ZERO, value: 85, asset: 70, roe: 30, safe: 30, divy: 25 },
  '배당주': { ...ZERO, divy: 100, safe: 50, roe: 30, value: 30 },
  '우량 대형': { ...ZERO, size: 70, roe: 65, safe: 50, divy: 30, value: 20 },
  '소형 발굴': { ...ZERO, size: -85, value: 65, asset: 55, roe: 45, safe: 25 },
  '성장주': { ...ZERO, grow: 100, roe: 60, mom: 35, size: 10 },
  '모멘텀': { ...ZERO, mom: 100, liq: 45, grow: 25 },
  '퀄리티': { ...ZERO, roe: 90, safe: 70, grow: 40, value: 25, divy: 15 },
  '내 평가순': { ...ZERO, mine: 100, roe: 20 },
};

const DEFAULT_PRESET = '시총순';

const DEFAULT_FILTERS = () => ({
  markets: [],
  sector: {},
  capMin: null,
  capMax: null,
  perMin: null,
  perMax: null,
  pbrMin: null,
  pbrMax: null,
  roeMin: null,
  roeMax: null,
  divMin: null,
  divMax: null,
  debtMin: null,
  debtMax: null,
  priceMin: null,
  priceMax: null,
  profitOnly: false,
  divOnly: false,
  commonOnly: true,
  risingOnly: false,
  myListOnly: false,
  // 내 목록 한 갈래만: null | 'want' | 'own' | 'sold' | 'rated'
  list: null,
  hideExcluded: true,
  q: '',
});

/** 한 번에 비교할 수 있는 종목 수 */
const COMPARE_MAX = 4;

/* ── 내 기록 ──────────────────────────────────────────────
 * 종목별로 붙는 개인 자료. localStorage 의 sl.notes 에 통째로 들어간다.
 *
 *   {
 *     rating: 8.5,       내 평가 (0~10)
 *     qty:    30,        보유 수량
 *     avg:    62000,     평균 매수가
 *     target: 55000,     목표가 ("이 값 이하면 산다")
 *     memo:   '...',
 *     trades: [ { date, side: 'buy'|'sell', qty, price } ]
 *   }
 *
 * 비어 있는 항목은 아예 저장하지 않는다(빈 객체가 쌓이면 내보낸 파일이 지저분해진다).
 */
const notes = JSON.parse(localStorage.getItem('sl.notes') ?? '{}');

const noteOf = (code) => notes[code];

/** 이 종목의 기록을 방금 고쳤다고 표시한다. 나중에 기기 간 병합에서 최신 판정에 쓴다. */
function touchNote(code) {
  const n = notes[code];
  if (n) n.u = Date.now();
}

function saveNotes() {
  for (const [code, n] of Object.entries(notes)) {
    const empty =
      n.rating == null &&
      !n.qty &&
      !n.avg &&
      !n.target &&
      !(n.memo ?? '').trim() &&
      !(n.trades ?? []).length;
    if (empty) delete notes[code];
  }
  localStorage.setItem('sl.notes', JSON.stringify(notes));
}

function noteFor(code) {
  return (notes[code] ??= {});
}

/** 보유 평가. 수량과 평단이 둘 다 있어야 계산된다. */
function position(stock) {
  const n = noteOf(stock.code);
  if (!n?.qty || !n?.avg) return null;
  const cost = n.qty * n.avg;
  const nowValue = stock.close != null ? n.qty * stock.close : null;
  const pl = nowValue == null ? null : nowValue - cost;
  return { qty: n.qty, avg: n.avg, cost, value: nowValue, pl, plPct: pl == null ? null : (pl / cost) * 100 };
}

/**
 * 거래 기록에서 수량과 평균 매수가를 계산한다.
 *
 * 매도할 때 평단은 그대로 두고 수량만 줄인다(이동평균법). 실현손익까지
 * 따지려면 세금·수수료가 필요한데 그건 이 도구가 알 수 없는 값이다.
 */
function fromTrades(code) {
  const rows = (noteOf(code)?.trades ?? []).filter((t) => t.qty > 0 && t.price > 0);
  if (!rows.length) return null;
  rows.sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')));
  let qty = 0;
  let cost = 0;
  for (const t of rows) {
    if (t.side === 'sell') {
      const sold = Math.min(qty, t.qty);
      if (qty > 0) cost -= (cost / qty) * sold;
      qty -= sold;
    } else {
      qty += t.qty;
      cost += t.qty * t.price;
    }
  }
  if (qty <= 0) return { qty: 0, avg: null };
  return { qty, avg: Math.round(cost / qty) };
}

/* ── 표시 (관심·보유·매도·제외) ───────────────────────── */
const FLAGS = [
  { key: 'want', glyph: '★', label: '관심' },
  { key: 'own', glyph: '●', label: '보유' },
  { key: 'sold', glyph: '○', label: '매도함' },
  { key: 'skip', glyph: '✕', label: '제외' },
];

const state = {
  data: null,
  weights: { ...PRESETS[DEFAULT_PRESET] },
  filters: DEFAULT_FILTERS(),
  sort: { key: 'score', dir: -1 },
  flags: JSON.parse(localStorage.getItem('sl.flags') ?? '{}'),
  compare: [],
  rendered: 0,
  view: [],
  viewMode: localStorage.getItem('sl.viewMode') === 'cards' ? 'cards' : 'table',
  showNotes: false,
};

const saveFlags = () => localStorage.setItem('sl.flags', JSON.stringify(state.flags));

const hasFlag = (code, key) => !!state.flags[code]?.[key];

/* ── 백분위 계산 ──────────────────────────────────────── */
function attachPercentiles(stocks) {
  for (const axis of AXES) {
    const pairs = [];
    for (const s of stocks) {
      const v = axis.value(s);
      if (v != null && Number.isFinite(v)) pairs.push([s, v]);
    }
    pairs.sort((a, b) => a[1] - b[1]);

    // 동점은 같은 백분위를 받아야 한다(평균 순위 방식)
    let i = 0;
    while (i < pairs.length) {
      let j = i;
      while (j + 1 < pairs.length && pairs[j + 1][1] === pairs[i][1]) j++;
      const p = pairs.length > 1 ? (i + j) / 2 / (pairs.length - 1) : 0.5;
      for (let k = i; k <= j; k++) (pairs[k][0].p ??= {})[axis.key] = p;
      i = j + 1;
    }
    // 값이 없는 종목은 중앙값으로 취급해 점수가 과하게 깎이지 않게 한다
    for (const s of stocks) (s.p ??= {})[axis.key] ??= 0.5;
  }
}

/** 내 평가가 바뀌면 그 축의 백분위만 다시 매긴다 */
function recomputeMineAxis() {
  const axis = AXES.find((a) => a.key === 'mine');
  const stocks = state.data.stocks;
  const pairs = [];
  for (const s of stocks) {
    const v = axis.value(s);
    if (v != null) pairs.push([s, v]);
    else delete s.p[axis.key];
  }
  pairs.sort((a, b) => a[1] - b[1]);
  let i = 0;
  while (i < pairs.length) {
    let j = i;
    while (j + 1 < pairs.length && pairs[j + 1][1] === pairs[i][1]) j++;
    const p = pairs.length > 1 ? (i + j) / 2 / (pairs.length - 1) : 0.5;
    for (let k = i; k <= j; k++) pairs[k][0].p[axis.key] = p;
    i = j + 1;
  }
  for (const s of stocks) s.p[axis.key] ??= 0.5;
}

function rawScore(s) {
  let sum = 0;
  for (const axis of AXES) {
    const w = state.weights[axis.key] ?? 0;
    if (w) sum += (w / 100) * s.p[axis.key];
  }
  return sum;
}

/* ── 필터 ─────────────────────────────────────────────── */
const inRange = (v, lo, hi) => {
  if (lo == null && hi == null) return true;
  if (v == null) return false; // 값이 없으면 범위를 걸었을 때 걸러진다
  if (lo != null && v < lo) return false;
  if (hi != null && v > hi) return false;
  return true;
};

function matches(s, f) {
  if (f.markets.length && !f.markets.includes(s.market)) return false;

  // 업종: 포함이 하나라도 있으면 그 안에서만, 제외는 항상 뺀다
  const sectorEntries = Object.entries(f.sector);
  if (sectorEntries.length) {
    const includes = sectorEntries.filter(([, m]) => m === 'include').map(([n]) => n);
    if (f.sector[s.sector] === 'exclude') return false;
    if (includes.length && !includes.includes(s.sector)) return false;
  }

  // 시가총액 칸은 억원 단위로 받는다 (1조 = 10,000억)
  if (!inRange(s.cap == null ? null : s.cap / 1e8, f.capMin, f.capMax)) return false;
  if (!inRange(s.per, f.perMin, f.perMax)) return false;
  if (!inRange(s.pbr, f.pbrMin, f.pbrMax)) return false;
  if (!inRange(s.roe, f.roeMin, f.roeMax)) return false;
  if (!inRange(s.divYield, f.divMin, f.divMax)) return false;
  if (!inRange(s.debt, f.debtMin, f.debtMax)) return false;
  if (!inRange(s.close, f.priceMin, f.priceMax)) return false;

  if (f.profitOnly && !(s.fin?.netIncome > 0)) return false;
  if (f.divOnly && !s.divYield) return false;
  if (f.commonOnly && s.kind && s.kind !== '보통주') return false;
  if (f.risingOnly && !(s.ret?.[90] > 0)) return false;

  if (f.hideExcluded && hasFlag(s.code, 'skip') && f.list !== 'skip') return false;

  if (f.myListOnly && !(hasFlag(s.code, 'want') || hasFlag(s.code, 'own'))) return false;
  if (f.list === 'rated') {
    if (noteOf(s.code)?.rating == null) return false;
  } else if (f.list && !hasFlag(s.code, f.list)) return false;

  if (f.q) {
    const q = f.q.toLowerCase();
    if (!s.name.toLowerCase().includes(q) && !s.code.includes(q)) return false;
  }
  return true;
}

/* ── 정렬 키 ──────────────────────────────────────────── */
const SORT_VALUE = {
  score: (s) => s._score,
  capRank: (s) => s.capRank,
  name: (s) => s.name ?? '',
  market: (s) => s.market ?? '',
  sector: (s) => s.sector ?? '',
  close: (s) => s.close,
  changePct: (s) => s.changePct,
  cap: (s) => s.cap,
  per: (s) => s.per,
  pbr: (s) => s.pbr,
  roe: (s) => s.roe,
  divYield: (s) => s.divYield,
  debt: (s) => s.debt,
  revGrowth: (s) => s.revGrowth,
  ret90: (s) => s.ret?.[90],
  ret365: (s) => s.ret?.[365],
  // 내 기록에서 나오는 값들
  mine: (s) => noteOf(s.code)?.rating,
  qty: (s) => noteOf(s.code)?.qty || null,
  pl: (s) => position(s)?.pl,
};

/*
 * mine: true 인 열은 "내 기록" 열이라 기본으로는 감춰 둔다.
 * 기록이 없으면 전부 '–' 라 표만 넓어지기 때문이다.
 * 기록이 하나라도 있으면 처음부터 켜진다(main 참고).
 */
const COLUMNS = [
  { key: 'score', label: '점수' },
  { key: 'capRank', label: '시총순위' },
  { key: 'name', label: '종목', left: true },
  { key: 'mine', label: '내 평가', mine: true },
  { key: 'qty', label: '보유', mine: true },
  { key: 'pl', label: '평가손익', mine: true },
  { key: 'close', label: '주가' },
  { key: 'changePct', label: '등락률' },
  { key: 'cap', label: '시가총액' },
  { key: 'per', label: 'PER' },
  { key: 'pbr', label: 'PBR' },
  { key: 'roe', label: 'ROE' },
  { key: 'divYield', label: '배당률' },
  { key: 'debt', label: '부채비율' },
  { key: 'revGrowth', label: '매출성장' },
  { key: 'ret90', label: '3개월' },
];

const visibleColumns = () => COLUMNS.filter((c) => !c.mine || state.showNotes);

/** 한 번에 이어서 그리는 줄 수 */
const PAGE = 80;

/** 자리를 되돌릴 때 한 번에 다시 그릴 수 있는 최대 줄 수 */
const RESTORE_MAX = 400;

/* ── 다시 계산 ────────────────────────────────────────── */
function recompute({ keepPosition = false } = {}) {
  const f = state.filters;
  const list = state.data.stocks.filter((s) => matches(s, f));
  for (const s of list) s._score = rawScore(s);

  // 화면에 보이는 0~100 점수는 지금 결과 집합 안에서 상대적으로 매긴다
  if (list.length) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of list) {
      if (s._score < lo) lo = s._score;
      if (s._score > hi) hi = s._score;
    }
    const span = hi - lo || 1;
    for (const s of list) s._score100 = Math.round(((s._score - lo) / span) * 1000) / 10;
  }

  const get = SORT_VALUE[state.sort.key] ?? SORT_VALUE.score;
  const dir = state.sort.dir;
  list.sort((a, b) => {
    const av = get(a);
    const bv = get(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1; // 값 없는 행은 항상 아래로
    if (bv == null) return -1;
    if (typeof av === 'string') return dir * av.localeCompare(bv, 'ko');
    return dir * (av - bv);
  });

  /*
   * 보고 있던 자리를 되돌릴지.
   *
   * 표시(관심·보유)를 눌렀을 때처럼 목록이 거의 그대로일 때만 되돌린다.
   * 가중치나 필터를 바꾸면 순서 자체가 달라져 원래 자리가 의미를 잃고,
   * 그때까지 그려둔 줄을 전부 다시 만드느라 오히려 크게 느려진다.
   */
  const prevRendered = state.rendered;
  const box = $('#tableWrap');
  const prevScroll = box.scrollTop;

  state.view = list;
  state.rendered = 0;
  $('#tbody').replaceChildren();
  $('#cards').replaceChildren();

  const target = keepPosition ? Math.min(Math.max(prevRendered, PAGE), RESTORE_MAX) : PAGE;
  while (state.rendered < target && state.rendered < list.length) renderMore();

  $('#resultCount').textContent = `${nf(list.length)}종목`;
  $('#empty').hidden = list.length > 0;
  renderShownCount();
  renderExcludedNote();
  updateSummaries();
  syncUrl();

  if (keepPosition) box.scrollTop = prevScroll;
}

let recomputeQueued = false;

/**
 * 슬라이더를 끄는 동안 input 이 초당 수십 번 나온다. 프레임당 한 번으로 묶지
 * 않으면 하나도 못 따라간다. 숫자 표시는 즉시 바꿔 손끝 반응은 유지한다.
 */
function recomputeSoon() {
  if (recomputeQueued) return;
  recomputeQueued = true;
  requestAnimationFrame(() => {
    recomputeQueued = false;
    recompute();
  });
}

function renderShownCount() {
  const n = state.view.length;
  $('#shownCount').textContent = n
    ? `${nf(n)}개 중 ${nf(Math.min(state.rendered, n))}개 표시`
    : '–';
}

function applyViewMode() {
  const cards = state.viewMode === 'cards';
  $('#table').hidden = cards;
  $('#cards').hidden = !cards;
  for (const b of $('#viewMode').children) b.classList.toggle('on', b.dataset.view === state.viewMode);
  localStorage.setItem('sl.viewMode', state.viewMode);
}

/* ── 렌더 ─────────────────────────────────────────────── */
function scorePill(score) {
  const tier = score >= 80 ? 5 : score >= 62 ? 4 : score >= 42 ? 3 : score >= 22 ? 2 : 1;
  return el('span', { className: `score-pill t${tier}`, textContent: nf(score, 1) });
}

function marketTag(market) {
  const cls = market === 'KOSPI' ? 'kospi' : market === 'KOSDAQ' ? 'kosdaq' : '';
  return el('span', { className: `tag ${cls}`, textContent: market ?? '–' });
}

function flagButton(s, flag) {
  const btn = el('button', {
    className: `flag-btn${hasFlag(s.code, flag.key) ? ' on' : ''}`,
    textContent: flag.glyph,
    title: flag.label,
  });
  btn.dataset.flag = flag.key;
  btn.onclick = (e) => {
    e.stopPropagation();
    const bag = (state.flags[s.code] ??= {});
    const next = !bag[flag.key];
    bag[flag.key] = next;
    if (!next) delete bag[flag.key];
    if (!Object.keys(bag).length) delete state.flags[s.code];
    saveFlags();

    /*
     * 표시를 눌러도 목록이 흔들리지 않게 한다.
     * 걸려 있는 필터가 표시를 보고 있을 때만 전체를 다시 만들고,
     * 그렇지 않으면 그 줄의 아이콘만 다시 칠한다.
     */
    const watching =
      state.filters.myListOnly ||
      state.filters.list != null ||
      (state.filters.hideExcluded && flag.key === 'skip') ||
      state.sort.key === 'score';
    if (watching) recompute({ keepPosition: true });
    else repaintFlags(s.code);
    refreshFolioIfOpen();
  };
  return btn;
}

/** 그 종목이 그려진 자리의 표시 아이콘만 다시 칠한다 */
function repaintFlags(code) {
  for (const node of document.querySelectorAll(`[data-code="${code}"] .flag-btn`)) {
    node.classList.toggle('on', hasFlag(code, node.dataset.flag));
  }
}

function compareButton(s) {
  const on = state.compare.includes(s.code);
  const btn = el('button', {
    className: `flag-btn${on ? ' on' : ''}`,
    textContent: '⇄',
    title: on ? '비교에서 빼기' : '비교에 담기',
  });
  btn.onclick = (e) => {
    e.stopPropagation();
    toggleCompare(s.code);
  };
  return btn;
}

function cell(value, extra = {}) {
  return el('td', { textContent: value, ...extra });
}

function renderRow(s) {
  const tr = el('tr');
  tr.dataset.code = s.code;

  for (const col of visibleColumns()) {
    let td;
    switch (col.key) {
      case 'score':
        td = el('td', {}, scorePill(s._score100 ?? 0));
        break;
      case 'capRank':
        td = cell(nf(s.capRank));
        break;
      case 'name':
        td = el(
          'td',
          { className: 'left' },
          el(
            'div',
            { className: 'name-cell' },
            el('span', { className: 'flags' }, FLAGS.map((f) => flagButton(s, f))),
            compareButton(s),
            el('span', { className: 'nm', textContent: s.name }),
            el('span', { className: 'code', textContent: s.code }),
            marketTag(s.market),
            s.kind && s.kind !== '보통주'
              ? el('span', { className: 'tag pref', textContent: s.kind })
              : null,
          ),
        );
        break;
      case 'mine': {
        const r = noteOf(s.code)?.rating;
        td = cell(r == null ? '–' : nf(r, 1));
        break;
      }
      case 'qty': {
        const q = noteOf(s.code)?.qty;
        td = cell(q ? `${nf(q)}주` : '–');
        break;
      }
      case 'pl': {
        const p = position(s);
        td = el('td', {}, p?.pl == null ? el('span', { className: 'flat', textContent: '–' }) : signed(p.pl, 0, '원'));
        break;
      }
      case 'close':
        td = cell(nf(s.close));
        break;
      case 'changePct':
        td = el('td', {}, signed(s.changePct));
        break;
      case 'cap':
        td = cell(money(s.cap));
        break;
      case 'per':
        td = cell(s.per == null ? (s.fin?.netIncome <= 0 ? '적자' : '–') : nf(s.per, 2));
        break;
      case 'pbr':
        td = cell(nf(s.pbr, 2));
        break;
      case 'roe':
        td = el('td', {}, s.roe == null ? el('span', { className: 'flat', textContent: '–' }) : signed(s.roe, 1));
        break;
      case 'divYield':
        td = cell(s.divYield == null ? '–' : pct(s.divYield));
        break;
      case 'debt':
        td = cell(s.debt == null ? '–' : pct(s.debt, 0));
        break;
      case 'revGrowth':
        td = el('td', {}, signed(s.revGrowth, 1));
        break;
      case 'ret90':
        td = el('td', {}, signed(s.ret?.[90], 1));
        break;
      default:
        td = cell('–');
    }
    if (col.left) td.classList.add('left');
    tr.append(td);
  }

  tr.onclick = () => openDrawer(s);
  return tr;
}

function renderCard(s) {
  const card = el('div', { className: 'card' });
  card.dataset.code = s.code;
  setChildren(
    card,
    el(
      'div',
      { className: 'card-top' },
      el(
        'div',
        {},
        el('div', { className: 'card-name', textContent: s.name }),
        el('div', { className: 'drawer-sub' }, marketTag(s.market), el('span', { textContent: s.sector ?? '' })),
      ),
      scorePill(s._score100 ?? 0),
    ),
    el('div', { className: 'card-price' }, el('span', { className: 'p', textContent: nf(s.close) }), signed(s.changePct)),
    el(
      'div',
      { className: 'card-metrics' },
      el('div', {}, el('span', { textContent: '시총' }), el('span', { textContent: money(s.cap) })),
      el('div', {}, el('span', { textContent: 'PER' }), el('span', { textContent: s.per == null ? '–' : nf(s.per, 1) })),
      el('div', {}, el('span', { textContent: 'PBR' }), el('span', { textContent: nf(s.pbr, 2) })),
      el('div', {}, el('span', { textContent: 'ROE' }), el('span', { textContent: s.roe == null ? '–' : pct(s.roe, 1) })),
      el('div', {}, el('span', { textContent: '배당' }), el('span', { textContent: s.divYield == null ? '–' : pct(s.divYield, 1) })),
      el('div', {}, el('span', { textContent: '3개월' }), el('span', {}, signed(s.ret?.[90], 1))),
    ),
    el('div', { className: 'flags' }, FLAGS.map((f) => flagButton(s, f)), compareButton(s)),
  );
  card.onclick = () => openDrawer(s);
  return card;
}

function renderMore() {
  const slice = state.view.slice(state.rendered, state.rendered + PAGE);
  if (!slice.length) return;
  const frag = document.createDocumentFragment();
  if (state.viewMode === 'cards') {
    for (const s of slice) frag.append(renderCard(s));
    $('#cards').append(frag);
  } else {
    for (const s of slice) frag.append(renderRow(s));
    $('#tbody').append(frag);
  }
  state.rendered += slice.length;
  renderShownCount();
}

function renderHead() {
  const row = $('#headRow');
  setChildren(
    row,
    visibleColumns().map((col) => {
      const on = state.sort.key === col.key;
      const th = el(
        'th',
        { className: col.left ? 'left' : '' },
        el('span', { textContent: col.label }),
        on ? el('span', { className: 'dir', textContent: state.sort.dir === -1 ? '▼' : '▲' }) : null,
      );
      th.onclick = () => {
        if (state.sort.key === col.key) state.sort.dir *= -1;
        // 이름·시장·업종은 오름차순이, 숫자는 내림차순이 처음에 맞다
        else state.sort = { key: col.key, dir: ['name', 'market', 'sector', 'capRank'].includes(col.key) ? 1 : -1 };
        renderHead();
        recompute();
      };
      return th;
    }),
  );
}

/* ── 제외 목록 관리 ───────────────────────────────────── */
function renderExcludedNote() {
  const codes = Object.keys(state.flags).filter((c) => state.flags[c]?.skip);
  const box = $('#excludedNote');
  box.hidden = codes.length === 0;
  if (!codes.length) return;
  const clear = el('button', { className: 'ghost-btn', textContent: '전부 풀기' });
  clear.onclick = () => {
    for (const c of codes) {
      delete state.flags[c].skip;
      if (!Object.keys(state.flags[c]).length) delete state.flags[c];
    }
    saveFlags();
    recompute();
  };
  setChildren(box, el('span', { textContent: `제외 표시 ${codes.length}종목 ` }), clear);
}

/* ── 비교 ─────────────────────────────────────────────── */
function toggleCompare(code) {
  const i = state.compare.indexOf(code);
  if (i >= 0) state.compare.splice(i, 1);
  else if (state.compare.length >= COMPARE_MAX) {
    toast(`비교는 ${COMPARE_MAX}개까지 담을 수 있습니다`);
    return;
  } else state.compare.push(code);
  refreshCompareUi();
}

function refreshCompareUi() {
  for (const node of document.querySelectorAll('[data-code]')) {
    const on = state.compare.includes(node.dataset.code);
    const btn = [...node.querySelectorAll('.flag-btn')].find((b) => b.textContent === '⇄');
    if (btn) btn.classList.toggle('on', on);
  }
  renderCompareBar();
  if (!$('#compareView').hidden) openCompare();
}

function renderCompareBar() {
  const bar = $('#compareBar');
  bar.hidden = state.compare.length === 0;
  if (bar.hidden) return;
  const byCode = new Map(state.data.stocks.map((s) => [s.code, s]));
  const names = state.compare.map((c) => byCode.get(c)?.name ?? c).join(' · ');
  const open = el('button', { className: 'ghost-btn primary', textContent: '비교하기' });
  open.onclick = openCompare;
  const clear = el('button', { className: 'ghost-btn', textContent: '비우기' });
  clear.onclick = () => {
    state.compare = [];
    refreshCompareUi();
  };
  setChildren(
    bar,
    el('span', { className: 'names', textContent: `${state.compare.length}개 담김 — ${names}` }),
    open,
    clear,
  );
}

/** 값들 중 가장 나은 자리들. 전부 같으면 아무 데도 강조하지 않는다. */
function bestIndexes(values, better) {
  const known = values.filter((v) => v != null && Number.isFinite(v));
  if (known.length < 2) return [];
  const top = better === 'high' ? Math.max(...known) : Math.min(...known);
  if (known.every((v) => v === top)) return [];
  return values.map((v, i) => (v === top ? i : -1)).filter((i) => i >= 0);
}

/* sign: true 인 줄은 부호와 색(오르면 빨강·내리면 파랑)을 붙여 그린다 */
const CMP_ROWS = [
  { label: '주가', get: (s) => s.close, fmt: won, better: null },
  { label: '등락률', get: (s) => s.changePct, sign: 2, better: 'high' },
  { label: '시가총액', get: (s) => s.cap, fmt: money, better: null },
  { label: 'PER', get: (s) => s.per, fmt: (v) => `${nf(v, 2)}배`, better: 'low' },
  { label: 'PBR', get: (s) => s.pbr, fmt: (v) => `${nf(v, 2)}배`, better: 'low' },
  { label: 'PSR', get: (s) => s.psr, fmt: (v) => `${nf(v, 2)}배`, better: 'low' },
  { label: 'ROE', get: (s) => s.roe, sign: 1, better: 'high' },
  { label: '영업이익률', get: (s) => s.opm, sign: 1, better: 'high' },
  { label: '배당수익률', get: (s) => s.divYield, fmt: (v) => pct(v), better: 'high' },
  { label: '배당성향', get: (s) => s.payout, fmt: (v) => pct(v, 0), better: null },
  { label: '부채비율', get: (s) => s.debt, fmt: (v) => pct(v, 0), better: 'low' },
  { label: '매출 증가율', get: (s) => s.revGrowth, sign: 1, better: 'high' },
  { label: '순이익 증가율', get: (s) => s.profitGrowth, sign: 1, better: 'high' },
  { label: '1개월', get: (s) => s.ret?.[30], sign: 1, better: 'high' },
  { label: '3개월', get: (s) => s.ret?.[90], sign: 1, better: 'high' },
  { label: '1년', get: (s) => s.ret?.[365], sign: 1, better: 'high' },
  { label: '매출액', get: (s) => s.fin?.revenue, fmt: money, better: null },
  { label: '영업이익', get: (s) => s.fin?.operatingIncome, fmt: money, better: null },
  { label: '당기순이익', get: (s) => s.fin?.netIncome, fmt: money, better: null },
  { label: '자본총계', get: (s) => s.fin?.equity, fmt: money, better: null },
];

function openCompare() {
  const byCode = new Map(state.data.stocks.map((s) => [s.code, s]));
  const picked = state.compare.map((c) => byCode.get(c)).filter(Boolean);
  if (!picked.length) return;

  const table = el('table');
  const head = el('tr', {}, el('th', { textContent: '' }));
  for (const s of picked) head.append(el('th', { textContent: s.name }));
  table.append(el('thead', {}, head));

  const tbody = el('tbody');
  for (const row of CMP_ROWS) {
    const values = picked.map(row.get);
    const best = row.better ? bestIndexes(values, row.better) : [];
    const tr = el('tr', {}, el('td', { textContent: row.label }));
    values.forEach((v, i) => {
      const td =
        v == null
          ? el('td', { textContent: '–' })
          : row.sign
            ? el('td', {}, signed(v, row.sign))
            : el('td', { textContent: row.fmt(v) });
      if (best.includes(i)) td.className = 'best';
      tr.append(td);
    });
    tbody.append(tr);
  }
  table.append(tbody);

  const close = el('button', { className: 'ghost-btn', textContent: '닫기' });
  close.onclick = () => ($('#compareView').hidden = true);

  setChildren(
    $('#compareView'),
    el(
      'div',
      { className: 'view-inner' },
      el('div', { className: 'view-head' }, el('h3', { textContent: '종목 비교' }), close),
      el('div', { className: 'cmp-table' }, table),
      el('p', { className: 'hint', textContent: '더 나은 값에 색을 넣었습니다. PER·PBR·부채비율은 낮은 쪽, 나머지는 높은 쪽입니다. 업종이 다르면 이 비교 자체가 의미가 흐려집니다 — 은행과 바이오의 PBR 은 같은 잣대로 볼 수 없습니다.' }),
    ),
  );
  $('#compareView').hidden = false;
}

/* ── 상세 서랍 ────────────────────────────────────────── */
const drawerMax = () => Math.min(window.innerWidth - 60, 900);

function setDrawerWidth(px, save = true) {
  const w = Math.max(340, Math.min(px, drawerMax()));
  $('#drawer').style.width = `${w}px`;
  if (save) localStorage.setItem('sl.drawerW', String(w));
}

function initDrawerResize() {
  const saved = Number(localStorage.getItem('sl.drawerW'));
  if (saved) setDrawerWidth(saved, false);
}

/** 손잡이는 패널에 붙어 있어야 아무리 스크롤해도 잡힌다 */
function drawerResizer() {
  const handle = el('div', { className: 'drawer-resizer', title: '끌어서 폭 조절 · 더블클릭하면 기본값' });
  handle.onmousedown = (e) => {
    e.preventDefault();
    handle.classList.add('dragging');
    const move = (ev) => setDrawerWidth(window.innerWidth - ev.clientX);
    const up = () => {
      handle.classList.remove('dragging');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  handle.ondblclick = () => setDrawerWidth(470);
  return handle;
}

function specRow(k, v, note) {
  return el(
    'div',
    { className: 'spec-row' },
    el('span', { className: 'k', textContent: k }),
    el('span', { className: 'v' }, typeof v === 'string' ? el('span', { textContent: v }) : v, note ? el('small', { textContent: note }) : null),
  );
}

/** 0을 가운데 두고 양쪽으로 뻗는 수익률 막대 */
function retBar(label, v) {
  const track = el('div', { className: 'track' });
  if (v != null && Number.isFinite(v)) {
    // ±60%를 양끝으로 본다. 그보다 큰 값은 끝에 붙는다.
    const ratio = Math.min(Math.abs(v) / 60, 1) * 50;
    const fill = el('div', { className: 'fill' });
    fill.style.background = v >= 0 ? 'var(--up)' : 'var(--down)';
    fill.style.width = `${ratio}%`;
    if (v >= 0) fill.style.left = '50%';
    else fill.style.right = '50%';
    track.append(fill);
  }
  return el(
    'div',
    { className: 'retbar' },
    el('span', { className: 'lbl', textContent: label }),
    track,
    el('span', { className: 'val' }, signed(v, 1)),
  );
}

const isAndroid = () => /Android/i.test(navigator.userAgent);
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent);
const isMobile = () => isAndroid() || isIOS();

function externalLink(key, s) {
  const cfg = CONFIG.LINKS?.[key];
  if (!cfg?.url) return null;
  const tpl = (isMobile() && cfg.mobile) || cfg.url;
  const href = tpl.replace('{code}', s.code).replace('{q}', encodeURIComponent(s.name));
  return el('a', { href, target: '_blank', rel: 'noopener noreferrer', textContent: cfg.label });
}

function openDrawer(s) {
  const drawer = $('#drawer');
  document.querySelectorAll('#tableWrap .open').forEach((r) => r.classList.remove('open'));
  document.querySelector(`tr[data-code="${s.code}"]`)?.classList.add('open');

  const close = el('button', { className: 'drawer-close', textContent: '✕', title: '닫기 (Esc)' });
  close.onclick = () => (drawer.hidden = true);

  const head = el(
    'div',
    { className: 'drawer-head' },
    el(
      'div',
      {},
      el('h3', { textContent: s.name }),
      el(
        'div',
        { className: 'drawer-sub' },
        el('span', { textContent: s.code }),
        marketTag(s.market),
        s.sector ? el('span', { className: 'tag', textContent: s.sector }) : null,
        s.kind && s.kind !== '보통주' ? el('span', { className: 'tag pref', textContent: s.kind }) : null,
      ),
    ),
    close,
  );

  const scroll = el('div', { className: 'drawer-scroll' });

  // 시세
  scroll.append(
    el(
      'div',
      { className: 'dsection' },
      el(
        'div',
        { className: 'price-big' },
        el('span', { className: 'p', textContent: nf(s.close) }),
        el('span', { className: 'd' }, signed(s.change, 0, '원'), el('span', { textContent: ' ' }), signed(s.changePct)),
      ),
      el(
        'div',
        { className: 'spec' },
        specRow('시가총액', money(s.cap), `시총 ${nf(s.capRank)}위`),
        specRow('상장주식수', s.shares ? `${nf(s.shares)}주` : '–'),
        specRow('거래대금', money(s.value)),
        specRow('당일 고가 / 저가', `${nf(s.high)} / ${nf(s.low)}`),
        s.listedOn ? specRow('상장일', s.listedOn) : null,
      ),
    ),
  );

  // 수익률
  scroll.append(
    el(
      'div',
      { className: 'dsection' },
      el('h4', { textContent: '기간 수익률' }),
      el('div', { className: 'retbars' }, retBar('1개월', s.ret?.[30]), retBar('3개월', s.ret?.[90]), retBar('1년', s.ret?.[365])),
      el('p', {
        className: 'hint',
        textContent: '액면분할·유상증자는 보정하지 않은 단순 종가 비교입니다. 그런 일이 있었던 종목은 실제와 다릅니다.',
      }),
    ),
  );

  // 지표 — 계산식을 함께 적는다. 어디서 나온 숫자인지 화면에서 바로 확인할 수 있게.
  const f = s.fin;
  scroll.append(
    el(
      'div',
      { className: 'dsection' },
      el('h4', { textContent: `투자 지표 ${f ? `· ${f.year}년 ${f.fs === 'CFS' ? '연결' : '개별'}` : ''}` }),
      el(
        'div',
        { className: 'spec' },
        specRow('PER', s.per == null ? (f?.netIncome <= 0 ? '적자' : '–') : `${nf(s.per, 2)}배`, '시가총액 ÷ 당기순이익'),
        specRow('PBR', s.pbr == null ? '–' : `${nf(s.pbr, 2)}배`, '시가총액 ÷ 자본총계'),
        specRow('PSR', s.psr == null ? '–' : `${nf(s.psr, 2)}배`, '시가총액 ÷ 매출액'),
        specRow('ROE', s.roe == null ? '–' : signed(s.roe, 1), '당기순이익 ÷ 자본총계'),
        specRow('영업이익률', s.opm == null ? '–' : pct(s.opm, 1), '영업이익 ÷ 매출액'),
        specRow('부채비율', s.debt == null ? '–' : pct(s.debt, 0), '부채총계 ÷ 자본총계'),
        specRow('배당수익률', s.divYield == null ? '–' : pct(s.divYield), f?.dps ? `주당 ${nf(f.dps)}원 ÷ 현재가` : '배당 기록 없음'),
        specRow('배당성향', s.payout == null ? '–' : pct(s.payout, 0), '배당총액 ÷ 당기순이익'),
      ),
    ),
  );

  // 재무 원자료
  if (f) {
    scroll.append(
      el(
        'div',
        { className: 'dsection' },
        el('h4', { textContent: `재무 (${f.year}년 사업보고서)` }),
        el(
          'div',
          { className: 'spec' },
          specRow('매출액', money(f.revenue), s.revGrowth == null ? '' : `전년 대비 ${nf(s.revGrowth, 1)}%`),
          specRow('영업이익', money(f.operatingIncome)),
          specRow('당기순이익', money(f.netIncome), s.profitGrowth == null ? '' : `전년 대비 ${nf(s.profitGrowth, 1)}%`),
          specRow('자산총계', money(f.assets)),
          specRow('부채총계', money(f.liabilities)),
          specRow('자본총계', money(f.equity)),
        ),
      ),
    );
  } else {
    scroll.append(
      el(
        'div',
        { className: 'dsection' },
        el('h4', { textContent: '재무' }),
        el('p', { className: 'hint', textContent: 'DART 에서 이 종목의 사업보고서를 찾지 못했습니다. 신규 상장·리츠·스팩·외국 기업에서 흔합니다.' }),
      ),
    );
  }

  // 표시 + 내 기록
  scroll.append(drawerFlags(s));
  scroll.append(noteSection(s));

  // 바깥 사이트
  const links = Object.keys(CONFIG.LINKS ?? {})
    .map((k) => externalLink(k, s))
    .filter(Boolean);
  if (links.length) {
    scroll.append(
      el('div', { className: 'dsection' }, el('h4', { textContent: '바깥에서 확인하기' }), el('div', { className: 'links' }, links)),
    );
  }

  scroll.append(
    el(
      'div',
      { className: 'dsection' },
      el('p', {
        className: 'hint',
        textContent:
          '이 화면의 값은 공시·시세 자료를 정리한 것이며 투자 조언이 아닙니다. 재무는 연 1회 사업보고서 기준이라 최근 분기 실적이 반영돼 있지 않고, 지표 하나로 좋고 나쁨을 가릴 수 있는 종목은 없습니다.',
      }),
    ),
  );

  const bottomClose = el('button', { className: 'ghost-btn', textContent: '닫기' });
  bottomClose.onclick = () => (drawer.hidden = true);
  scroll.append(el('div', { className: 'dsection' }, bottomClose));

  setChildren(drawer, drawerResizer(), head, scroll);
  drawer.hidden = false;
  scroll.scrollTop = 0;
}

function drawerFlags(s) {
  const row = el('div', { className: 'flags' });
  row.dataset.code = s.code;
  for (const f of FLAGS) {
    const btn = flagButton(s, f);
    btn.append(el('span', { textContent: ` ${f.label}`, style: 'font-size:11.5px' }));
    row.append(btn);
  }
  return el('div', { className: 'dsection' }, el('h4', { textContent: '내 표시' }), row);
}

/* ── 내 기록 편집 ─────────────────────────────────────── */
function refreshFolioIfOpen() {
  if (!$('#folioView').hidden) openFolio();
}

const today = () => new Date().toISOString().slice(0, 10);

/** 별 다섯 개 = 10점. 반 칸이 1점. */
function ratingStars(value, onSet) {
  const wrap = el('div', { className: 'stars' });
  const row = el('div', { className: 'star-row' });
  const label = el('span', { className: 'num', textContent: value == null ? '–' : nf(value, 1) });

  const paint = (v) => {
    [...row.children].forEach((star, i) => {
      const filled = Math.max(0, Math.min(1, (v ?? 0) / 2 - i));
      star.querySelector('.fillbar').style.width = `${filled * 100}%`;
    });
    label.textContent = v == null ? '–' : nf(v, 1);
  };

  for (let i = 0; i < 5; i++) {
    const star = el('span', { className: 'star' }, el('i', { className: 'fillbar' }));
    for (const side of ['l', 'r']) {
      const score = i * 2 + (side === 'l' ? 1 : 2);
      const half = el('span', { className: `half ${side}`, title: `${score}점` });
      half.onmouseenter = () => paint(score);
      half.onclick = (e) => {
        e.stopPropagation();
        // 같은 점수를 다시 누르면 지운다
        onSet(value === score ? null : score);
      };
      star.append(half);
    }
    row.append(star);
  }
  row.onmouseleave = () => paint(value);
  paint(value);

  wrap.append(row, label);
  return wrap;
}

function noteField(label, { type = 'number', value, placeholder = '', onSet, wide = false, step }) {
  const input = el(type === 'textarea' ? 'textarea' : 'input', {
    value: value ?? '',
    placeholder,
  });
  if (type !== 'textarea') input.type = type;
  if (step) input.step = step;
  input.onchange = () => {
    const raw = input.value.trim();
    if (type === 'number') onSet(raw === '' ? null : Number(raw));
    else onSet(raw === '' ? null : raw);
  };
  input.onclick = (e) => e.stopPropagation();
  return el('div', { className: `note-field${wide ? ' wide' : ''}` }, el('label', { textContent: label }), input);
}

function noteSection(s) {
  const box = el('div', { className: 'dsection' });

  const rerender = () => {
    setChildren(box, ...buildNote());
    autoShowNoteColumns();
  };

  function buildNote() {
    const n = noteOf(s.code) ?? {};
    const grid = el('div', { className: 'note-grid' });

    grid.append(
      el(
        'div',
        { className: 'note-field wide' },
        el('label', { textContent: '내 평가 (별 반 칸 = 1점)' }),
        ratingStars(n.rating ?? null, (v) => {
          const note = noteFor(s.code);
          if (v == null) delete note.rating;
          else note.rating = v;
          touchNote(s.code);
          saveNotes();
          recomputeMineAxis();
          rerender();
          // 내 평가는 점수 축이므로 목록 순서가 바뀔 수 있다
          if (state.weights.mine) recompute({ keepPosition: true });
          else repaintRating(s.code, v);
          refreshFolioIfOpen();
        }),
      ),
    );

    const set = (key) => (v) => {
      const note = noteFor(s.code);
      if (v == null) delete note[key];
      else note[key] = v;
      touchNote(s.code);
      saveNotes();
      rerender();
      recompute({ keepPosition: true });
      refreshFolioIfOpen();
    };

    grid.append(noteField('보유 수량(주)', { value: n.qty, onSet: set('qty'), placeholder: '0' }));
    grid.append(noteField('평균 매수가(원)', { value: n.avg, onSet: set('avg'), placeholder: '0' }));
    grid.append(noteField('목표가(원)', { value: n.target, onSet: set('target'), placeholder: '이 값 이하면 산다' }));
    grid.append(
      noteField('메모', { type: 'textarea', value: n.memo, onSet: set('memo'), wide: true, placeholder: '왜 담았는지, 무엇을 지켜볼지' }),
    );

    const parts = [el('h4', { textContent: '내 기록' }), grid];

    // 계산되는 값들
    const p = position(s);
    const calc = el('div', { className: 'calc' });
    if (p) {
      calc.append(
        el('div', {}, el('span', { textContent: '매수 금액' }), el('span', { textContent: won(p.cost) })),
        el('div', {}, el('span', { textContent: '평가 금액' }), el('span', { textContent: won(p.value) })),
        el('div', {}, el('span', { textContent: '평가 손익' }), el('span', {}, signed(p.pl, 0, '원'))),
        el('div', {}, el('span', { textContent: '수익률' }), el('span', {}, signed(p.plPct, 2))),
      );
    }
    if (n.target && s.close) {
      const gap = ((s.close - n.target) / n.target) * 100;
      calc.append(
        el(
          'div',
          {},
          el('span', { textContent: '목표가 대비' }),
          el('span', {}, signed(gap, 1), el('span', { textContent: gap <= 0 ? '  (도달)' : '' })),
        ),
      );
    }
    if (calc.children.length) parts.push(calc);

    parts.push(tradeSection(s, rerender));
    return parts;
  }

  setChildren(box, ...buildNote());
  return box;
}

/** 표에 그려진 내 평가 칸만 다시 칠한다 */
function repaintRating(code, v) {
  const idx = visibleColumns().findIndex((c) => c.key === 'mine');
  if (idx < 0) return;
  const td = document.querySelector(`tr[data-code="${code}"]`)?.children[idx];
  if (td) td.textContent = v == null ? '–' : nf(v, 1);
}

function tradeSection(s, rerender) {
  const n = noteOf(s.code) ?? {};
  const rows = n.trades ?? [];
  const box = el('div', { style: 'margin-top:14px' });

  const list = el('div', { className: 'spec' });
  rows.forEach((t, i) => {
    const del = el('button', { className: 'ghost-btn', textContent: '삭제' });
    del.onclick = () => {
      noteFor(s.code).trades.splice(i, 1);
      touchNote(s.code);
      saveNotes();
      rerender();
    };
    list.append(
      el(
        'div',
        { className: 'spec-row' },
        el('span', { className: 'k', textContent: `${t.date ?? '날짜 없음'} · ${t.side === 'sell' ? '매도' : '매수'}` }),
        el('span', { className: 'v' }, el('span', { textContent: `${nf(t.qty)}주 × ${nf(t.price)}원` }), del),
      ),
    );
  });

  const add = el('button', { className: 'ghost-btn', textContent: '+ 거래 추가' });
  add.onclick = () => {
    const note = noteFor(s.code);
    (note.trades ??= []).push({ date: today(), side: 'buy', qty: 0, price: s.close ?? 0 });
    touchNote(s.code);
    saveNotes();
    rerender();
  };

  const actions = el('div', { className: 'links', style: 'margin-top:8px' }, add);

  if (rows.length) {
    const calc = fromTrades(s.code);
    const fill = el('button', {
      className: 'ghost-btn',
      textContent: calc?.avg ? `평단 ${nf(calc.avg)}원 · ${nf(calc.qty)}주로 채우기` : '보유 없음(전량 매도)',
    });
    fill.onclick = () => {
      const note = noteFor(s.code);
      note.qty = calc?.qty || null;
      note.avg = calc?.avg || null;
      if (!note.qty) delete note.qty;
      if (!note.avg) delete note.avg;
      touchNote(s.code);
      saveNotes();
      rerender();
      recompute({ keepPosition: true });
      refreshFolioIfOpen();
    };
    actions.append(fill);
  }

  // 거래 줄은 값을 직접 고칠 수 있어야 쓸모가 있다
  rows.forEach((t, i) => {
    const grid = el('div', { className: 'note-grid', style: 'margin-top:6px' });
    const upd = (key) => (v) => {
      noteFor(s.code).trades[i][key] = v;
      touchNote(s.code);
      saveNotes();
      rerender();
    };
    grid.append(noteField('날짜', { type: 'date', value: t.date, onSet: upd('date') }));
    const sel = el(
      'select',
      {},
      el('option', { value: 'buy', textContent: '매수', selected: t.side !== 'sell' }),
      el('option', { value: 'sell', textContent: '매도', selected: t.side === 'sell' }),
    );
    sel.onchange = () => upd('side')(sel.value);
    grid.append(el('div', { className: 'note-field' }, el('label', { textContent: '구분' }), sel));
    grid.append(noteField('수량(주)', { value: t.qty, onSet: (v) => upd('qty')(v ?? 0) }));
    grid.append(noteField('단가(원)', { value: t.price, onSet: (v) => upd('price')(v ?? 0) }));
    box.append(grid);
  });

  return el(
    'div',
    {},
    el('h4', { textContent: '거래 기록', style: 'margin-top:16px' }),
    rows.length ? list : el('p', { className: 'hint', textContent: '한 주도 안 적어도 됩니다. 위의 수량·평단만으로 평가손익이 계산됩니다.' }),
    box,
    actions,
  );
}

/** 기록이 하나라도 생기면 표의 "내 기록" 열을 자동으로 켠다 */
function autoShowNoteColumns() {
  if (state.showNotes || !Object.keys(notes).length) return;
  state.showNotes = true;
  $('#showNotes').checked = true;
  renderHead();
  recompute({ keepPosition: true });
}

/* ── 내 포트폴리오 ────────────────────────────────────── */
function openFolio() {
  const byCode = new Map(state.data.stocks.map((s) => [s.code, s]));

  const held = [];
  for (const [code, n] of Object.entries(notes)) {
    const s = byCode.get(code);
    if (!s) continue;
    const p = position(s);
    if (p && n.qty > 0) held.push({ s, p });
  }
  held.sort((a, b) => (b.p.value ?? 0) - (a.p.value ?? 0));

  const totalCost = held.reduce((a, h) => a + h.p.cost, 0);
  const totalValue = held.reduce((a, h) => a + (h.p.value ?? h.p.cost), 0);
  const totalPl = totalValue - totalCost;

  const stats = el('div', { className: 'stat-grid' });
  const stat = (k, v, n) =>
    el('div', { className: 'stat' }, el('div', { className: 'k', textContent: k }), el('div', { className: 'v' }, v), n ? el('div', { className: 'n', textContent: n }) : null);

  stats.append(
    stat('보유 종목', el('span', { textContent: `${held.length}종목` })),
    stat('매수 금액', el('span', { textContent: won(totalCost) })),
    stat('평가 금액', el('span', { textContent: won(totalValue) })),
    stat('평가 손익', signed(totalPl, 0, '원'), totalCost ? `${nf((totalPl / totalCost) * 100, 2)}%` : ''),
  );

  const sections = [];

  // 보유
  if (held.length) {
    const list = el('div', { className: 'folio-list' });
    for (const { s, p } of held) {
      const share = totalValue ? ((p.value ?? 0) / totalValue) * 100 : 0;
      const row = el(
        'div',
        { className: 'folio-row' },
        el(
          'div',
          { className: 'who' },
          el('b', { textContent: s.name }),
          el('small', { textContent: `${nf(p.qty)}주 · 평단 ${nf(p.avg)}원 · 현재 ${nf(s.close)}원 · 비중 ${nf(share, 1)}%` }),
        ),
        el('div', { className: 'amt' }, el('b', { textContent: won(p.value) }), el('small', {}, signed(p.plPct, 2))),
        el('div', { className: 'weightbar' }, el('i', { style: `width:${share}%` })),
      );
      row.onclick = () => openDrawer(s);
      list.append(row);
    }
    sections.push(folioSection('보유 중', held.length, list));
  }

  // 업종 분산 — 한 업종에 몰려 있는지 한눈에
  if (held.length) {
    const bySector = {};
    for (const { s, p } of held) bySector[s.sector ?? '분류 없음'] = (bySector[s.sector ?? '분류 없음'] ?? 0) + (p.value ?? 0);
    const entries = Object.entries(bySector).sort((a, b) => b[1] - a[1]);
    const list = el('div', { className: 'folio-list' });
    for (const [name, amount] of entries) {
      const share = totalValue ? (amount / totalValue) * 100 : 0;
      list.append(
        el(
          'div',
          { className: 'folio-row' },
          el('div', { className: 'who' }, el('b', { textContent: name })),
          el('div', { className: 'amt' }, el('b', { textContent: won(amount) }), el('small', { textContent: `${nf(share, 1)}%` })),
          el('div', { className: 'weightbar' }, el('i', { style: `width:${share}%` })),
        ),
      );
    }
    sections.push(folioSection('업종 분산', entries.length, list));
  }

  // 관심 — 목표가에 얼마나 가까운지
  const watching = Object.keys(state.flags)
    .filter((c) => state.flags[c]?.want && byCode.has(c))
    .map((c) => byCode.get(c))
    .sort((a, b) => {
      const ga = noteOf(a.code)?.target ? (a.close - noteOf(a.code).target) / noteOf(a.code).target : Infinity;
      const gb = noteOf(b.code)?.target ? (b.close - noteOf(b.code).target) / noteOf(b.code).target : Infinity;
      return ga - gb;
    });

  if (watching.length) {
    const list = el('div', { className: 'folio-list' });
    for (const s of watching) {
      const target = noteOf(s.code)?.target;
      const gap = target ? ((s.close - target) / target) * 100 : null;
      const row = el(
        'div',
        { className: 'folio-row' },
        el(
          'div',
          { className: 'who' },
          el('b', { textContent: s.name }),
          el('small', { textContent: target ? `목표가 ${nf(target)}원 · 현재 ${nf(s.close)}원` : `현재 ${nf(s.close)}원 · 목표가 미입력` }),
        ),
        el('div', { className: 'amt' }, el('b', {}, gap == null ? el('span', { className: 'flat', textContent: '–' }) : signed(gap, 1)), el('small', { textContent: gap != null && gap <= 0 ? '도달' : '' })),
      );
      row.onclick = () => openDrawer(s);
      list.append(row);
    }
    sections.push(folioSection('관심 종목', watching.length, list));
  }

  // 매도함
  const sold = Object.keys(state.flags)
    .filter((c) => state.flags[c]?.sold && byCode.has(c))
    .map((c) => byCode.get(c));
  if (sold.length) {
    const list = el('div', { className: 'folio-list' });
    for (const s of sold) {
      const row = el(
        'div',
        { className: 'folio-row' },
        el('div', { className: 'who' }, el('b', { textContent: s.name }), el('small', { textContent: noteOf(s.code)?.memo ?? '' })),
        el('div', { className: 'amt' }, el('b', { textContent: won(s.close) }), el('small', {}, signed(s.ret?.[90], 1))),
      );
      row.onclick = () => openDrawer(s);
      list.append(row);
    }
    sections.push(folioSection('매도한 종목', sold.length, list));
  }

  if (!sections.length) {
    sections.push(
      el(
        'div',
        { className: 'folio-section' },
        el('div', {
          className: 'folio-empty',
          textContent: '아직 기록이 없습니다. 표에서 ★(관심)이나 ●(보유)를 누르거나, 종목을 열어 수량·평단을 적어 보세요.',
        }),
      ),
    );
  }

  const close = el('button', { className: 'ghost-btn', textContent: '닫기' });
  close.onclick = () => ($('#folioView').hidden = true);

  const exportBtn = el('button', { className: 'ghost-btn', textContent: '백업 내보내기' });
  exportBtn.onclick = exportNotes;
  const importBtn = el('button', { className: 'ghost-btn', textContent: '가져오기' });
  importBtn.onclick = importNotes;

  setChildren(
    $('#folioView'),
    el(
      'div',
      { className: 'view-inner' },
      el(
        'div',
        { className: 'view-head' },
        el('h3', { textContent: '내 포트폴리오' }),
        el('div', { className: 'result-actions' }, exportBtn, importBtn, close),
      ),
      stats,
      ...sections,
      el('p', {
        className: 'hint',
        textContent:
          '기록은 이 브라우저에만 저장됩니다. 브라우저 자료를 지우면 함께 사라지므로 가끔 백업을 내보내 두세요. 평가 금액은 최근 거래일 종가 기준이며, 수수료·세금·배당은 넣지 않았습니다.',
      }),
    ),
  );
  $('#folioView').hidden = false;
}

function folioSection(title, count, body) {
  return el(
    'div',
    { className: 'folio-section' },
    el('h4', {}, el('span', { textContent: title }), el('span', { className: 'badge', textContent: nf(count) })),
    body,
  );
}

/* ── 백업 ─────────────────────────────────────────────── */
function download(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportNotes() {
  download(`주식기록-${today()}.json`, JSON.stringify({ v: 1, at: Date.now(), notes, flags: state.flags }, null, 1));
  toast('기록을 파일로 내보냈습니다');
}

function importNotes() {
  const input = el('input', { type: 'file', accept: 'application/json' });
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      toast('읽을 수 없는 파일입니다');
      return;
    }
    const incoming = data.notes ?? {};
    const overlap = Object.keys(incoming).filter((c) => notes[c]);

    /*
     * 덮어쓰지 않고 종목 단위로 합친다. 다른 기기에서 적은 것을 가져올 때
     * 한쪽이 통째로 사라지면 안 되기 때문이다. 겹치는 것이 있으면 먼저 묻는다.
     */
    if (overlap.length) {
      const ok = await confirmDialog({
        title: '겹치는 기록이 있습니다',
        body: `${overlap.length}종목이 이미 이 브라우저에 있습니다. 가져온 쪽으로 덮어쓸까요? (겹치지 않는 것은 그대로 합쳐집니다)`,
        confirmText: '덮어쓰기',
        cancelText: '건너뛰기',
      });
      for (const [code, n] of Object.entries(incoming)) {
        if (notes[code] && !ok) continue;
        notes[code] = n;
      }
    } else {
      Object.assign(notes, incoming);
    }
    Object.assign(state.flags, data.flags ?? {});
    saveNotes();
    saveFlags();
    recomputeMineAxis();
    state.showNotes = Object.keys(notes).length > 0;
    $('#showNotes').checked = state.showNotes;
    renderHead();
    recompute();
    refreshFolioIfOpen();
    toast(`${Object.keys(incoming).length}종목을 가져왔습니다`);
  };
  input.click();
}

/* ── 확인 창 ──────────────────────────────────────────── */
function confirmDialog({ title, body, confirmText = '확인', cancelText = '취소', danger = false }) {
  return new Promise((resolve) => {
    const modal = $('#modal');
    const done = (v) => {
      modal.hidden = true;
      resolve(v);
    };
    const ok = el('button', { className: `ghost-btn ${danger ? 'danger' : 'primary'}`, textContent: confirmText });
    ok.onclick = () => done(true);
    const cancel = el('button', { className: 'ghost-btn', textContent: cancelText });
    cancel.onclick = () => done(false);
    setChildren(
      modal,
      el(
        'div',
        { className: 'modal-box' },
        el('h4', { textContent: title }),
        el('p', { textContent: body }),
        el('div', { className: 'modal-actions' }, cancel, ok),
      ),
    );
    modal.hidden = false;
    modal.onclick = (e) => {
      if (e.target === modal) done(false);
    };
  });
}

/* ── 점수 UI ──────────────────────────────────────────── */
function buildPresets() {
  setChildren(
    $('#presets'),
    Object.keys(PRESETS).map((name) => {
      const btn = el('button', { textContent: name });
      btn.dataset.preset = name;
      btn.onclick = () => {
        state.weights = { ...PRESETS[name] };
        syncSliders();
        markPreset();
        recompute();
      };
      return btn;
    }),
  );
}

function buildSliders() {
  setChildren(
    $('#sliders'),
    AXES.map((axis) => {
      const val = el('span', { className: 'val' });
      const input = el('input', { type: 'range', min: -100, max: 100, step: 5, value: state.weights[axis.key] ?? 0 });
      input.dataset.axis = axis.key;
      input.oninput = () => {
        const v = Number(input.value);
        state.weights[axis.key] = v;
        paintVal(val, v);
        markPreset();
        recomputeSoon();
      };
      paintVal(val, state.weights[axis.key] ?? 0);
      return el(
        'div',
        { className: 'slider-row' },
        el('div', { className: 'name' }, el('span', { textContent: axis.label }), el('small', { textContent: axis.note })),
        val,
        input,
      );
    }),
  );
}

function paintVal(node, v) {
  node.textContent = v > 0 ? `+${v}` : String(v);
  node.className = `val ${v > 0 ? 'pos' : v < 0 ? 'neg' : 'zero'}`;
}

function syncSliders() {
  for (const input of $('#sliders').querySelectorAll('input[type=range]')) {
    const v = state.weights[input.dataset.axis] ?? 0;
    input.value = String(v);
    paintVal(input.closest('.slider-row').querySelector('.val'), v);
  }
}

/** 지금 가중치와 똑같은 프리셋이 있으면 그 버튼을 켠다 */
function markPreset() {
  const now = AXES.map((a) => state.weights[a.key] ?? 0).join(',');
  let hit = null;
  for (const [name, w] of Object.entries(PRESETS)) {
    if (AXES.map((a) => w[a.key] ?? 0).join(',') === now) hit = name;
  }
  for (const btn of $('#presets').children) btn.classList.toggle('on', btn.dataset.preset === hit);
  state._preset = hit;
  updateSummaries();
}

/** 패널을 접어도 지금 설정이 무엇인지 한 줄로 남는다 */
function updateSummaries() {
  const active = AXES.filter((a) => state.weights[a.key]);
  $('#scoreSummary').textContent = state._preset
    ? `· ${state._preset}`
    : active.length
      ? `· 직접 조절 (${active.slice(0, 3).map((a) => `${a.label} ${state.weights[a.key] > 0 ? '+' : ''}${state.weights[a.key]}`).join(', ')}${active.length > 3 ? ' …' : ''})`
      : '· 가중치 없음';

  const f = state.filters;
  const def = DEFAULT_FILTERS();
  let n = 0;
  for (const [k, v] of Object.entries(f)) {
    if (k === 'sector') n += Object.keys(v).length;
    else if (Array.isArray(v)) n += v.length ? 1 : 0;
    else if (v !== def[k] && v != null && v !== '') n++;
  }
  $('#filterSummary').textContent = n ? `· ${n}개 걸림` : '';
}

/* ── 필터 UI ──────────────────────────────────────────── */
function chipGroup(host, items, isOn, onPick) {
  setChildren(
    host,
    items.map(({ label, value, title }) => {
      const btn = el('button', { textContent: label, title: title ?? '' });
      btn.classList.toggle('on', isOn(value));
      btn.onclick = () => {
        onPick(value);
        recompute();
        buildFilters();
      };
      return btn;
    }),
  );
}

function dualRange(host, { min, max, onSet, step, placeholder = ['최소', '최대'] }) {
  const lo = el('input', { type: 'number', value: min ?? '', placeholder: placeholder[0] });
  const hi = el('input', { type: 'number', value: max ?? '', placeholder: placeholder[1] });
  if (step) {
    lo.step = step;
    hi.step = step;
  }
  const commit = () => {
    onSet(lo.value === '' ? null : Number(lo.value), hi.value === '' ? null : Number(hi.value));
    recompute();
    buildFilters();
  };
  lo.onchange = commit;
  hi.onchange = commit;
  setChildren(host, lo, el('span', { textContent: '~' }), hi);
}

function rangeLabel(lo, hi, unit = '') {
  if (lo == null && hi == null) return '전체';
  if (lo == null) return `${nf(hi)}${unit} 이하`;
  if (hi == null) return `${nf(lo)}${unit} 이상`;
  return `${nf(lo)}${unit} ~ ${nf(hi)}${unit}`;
}

function buildFilters() {
  const f = state.filters;

  // 시장
  const markets = [...new Set(state.data.stocks.map((s) => s.market))].filter(Boolean);
  chipGroup(
    $('#marketChips'),
    markets.map((m) => ({ label: m, value: m })),
    (v) => f.markets.includes(v),
    (v) => {
      const i = f.markets.indexOf(v);
      if (i >= 0) f.markets.splice(i, 1);
      else f.markets.push(v);
    },
  );
  $('#marketLabel').textContent = f.markets.length ? f.markets.join(', ') : '전체';

  // 시가총액 (억원)
  dualRange($('#capRange'), {
    min: f.capMin,
    max: f.capMax,
    onSet: (a, b) => {
      f.capMin = a;
      f.capMax = b;
    },
  });
  const capPresets = [
    { label: '대형 1조↑', value: [10000, null] },
    { label: '중형 3천억~1조', value: [3000, 10000] },
    { label: '소형 ~3천억', value: [null, 3000] },
  ];
  chipGroup(
    $('#capChips'),
    capPresets,
    (v) => f.capMin === v[0] && f.capMax === v[1],
    (v) => {
      const on = f.capMin === v[0] && f.capMax === v[1];
      f.capMin = on ? null : v[0];
      f.capMax = on ? null : v[1];
    },
  );
  $('#capLabel').textContent = rangeLabel(f.capMin, f.capMax, '억');

  const simpleRange = (rangeId, chipsId, labelId, minKey, maxKey, chips, unit, step) => {
    dualRange($(rangeId), {
      min: f[minKey],
      max: f[maxKey],
      step,
      onSet: (a, b) => {
        f[minKey] = a;
        f[maxKey] = b;
      },
    });
    chipGroup(
      $(chipsId),
      chips,
      (v) => f[minKey] === v[0] && f[maxKey] === v[1],
      (v) => {
        const on = f[minKey] === v[0] && f[maxKey] === v[1];
        f[minKey] = on ? null : v[0];
        f[maxKey] = on ? null : v[1];
      },
    );
    $(labelId).textContent = rangeLabel(f[minKey], f[maxKey], unit);
  };

  simpleRange('#perRange', '#perChips', '#perLabel', 'perMin', 'perMax', [
    { label: '10 이하', value: [null, 10] },
    { label: '10~20', value: [10, 20] },
    { label: '20 초과', value: [20, null] },
  ], '', '0.1');

  simpleRange('#pbrRange', '#pbrChips', '#pbrLabel', 'pbrMin', 'pbrMax', [
    { label: '1 이하', value: [null, 1] },
    { label: '1~2', value: [1, 2] },
    { label: '2 초과', value: [2, null] },
  ], '', '0.1');

  simpleRange('#roeRange', '#roeChips', '#roeLabel', 'roeMin', 'roeMax', [
    { label: '10%↑', value: [10, null] },
    { label: '15%↑', value: [15, null] },
    { label: '20%↑', value: [20, null] },
  ], '%', '0.1');

  simpleRange('#divRange', '#divChips', '#divLabel', 'divMin', 'divMax', [
    { label: '2%↑', value: [2, null] },
    { label: '4%↑', value: [4, null] },
    { label: '6%↑', value: [6, null] },
  ], '%', '0.1');

  simpleRange('#debtRange', '#debtChips', '#debtLabel', 'debtMin', 'debtMax', [
    { label: '100% 이하', value: [null, 100] },
    { label: '200% 이하', value: [null, 200] },
  ], '%', '1');

  dualRange($('#priceRange'), {
    min: f.priceMin,
    max: f.priceMax,
    onSet: (a, b) => {
      f.priceMin = a;
      f.priceMax = b;
    },
  });
  $('#priceLabel').textContent = rangeLabel(f.priceMin, f.priceMax, '원');

  // 업종 — 눌러서 포함 → 제외 → 해제
  const sectors = Object.entries(state.data.sectors ?? {}).sort((a, b) => b[1] - a[1]);
  setChildren(
    $('#sectorBox'),
    sectors.map(([name, count]) => {
      const mode = f.sector[name];
      const btn = el(
        'button',
        { className: mode ?? '', title: '누를 때마다 포함 → 제외 → 해제' },
        el('span', { textContent: name }),
        el('span', { className: 'cnt', textContent: nf(count) }),
      );
      btn.onclick = () => {
        if (!mode) f.sector[name] = 'include';
        else if (mode === 'include') f.sector[name] = 'exclude';
        else delete f.sector[name];
        recompute();
        buildFilters();
      };
      return btn;
    }),
  );

  // 내 목록
  const listItems = [
    { label: '관심', value: 'want' },
    { label: '보유', value: 'own' },
    { label: '매도함', value: 'sold' },
    { label: '제외', value: 'skip' },
    { label: '평가함', value: 'rated' },
  ];
  chipGroup(
    $('#listChips'),
    listItems,
    (v) => f.list === v,
    (v) => (f.list = f.list === v ? null : v),
  );
  $('#listLabel').textContent = listItems.find((i) => i.value === f.list)?.label ?? '전체';

  // 체크박스
  for (const [id, key] of [
    ['profitOnly', 'profitOnly'],
    ['divOnly', 'divOnly'],
    ['commonOnly', 'commonOnly'],
    ['risingOnly', 'risingOnly'],
    ['myListOnly', 'myListOnly'],
    ['hideExcluded', 'hideExcluded'],
  ]) {
    const box = document.getElementById(id);
    box.checked = f[key];
    box.onchange = () => {
      f[key] = box.checked;
      recompute();
    };
  }
}

/* ── URL 상태 ─────────────────────────────────────────── */
function syncUrl() {
  const p = new URLSearchParams();
  const w = AXES.map((a) => state.weights[a.key] ?? 0).join(',');
  if (w !== AXES.map((a) => PRESETS[DEFAULT_PRESET][a.key] ?? 0).join(',')) p.set('w', w);

  const f = state.filters;
  const def = DEFAULT_FILTERS();
  for (const [k, v] of Object.entries(f)) {
    if (k === 'sector') {
      const s = Object.entries(v)
        .map(([n, m]) => (m === 'exclude' ? '!' : '') + n)
        .join('|');
      if (s) p.set(k, s);
    } else if (Array.isArray(v)) {
      if (v.length) p.set(k, v.join(','));
    } else if (v !== def[k] && v != null && v !== '') {
      p.set(k, String(v));
    }
  }
  if (state.sort.key !== 'score' || state.sort.dir !== -1) p.set('sort', `${state.sort.key}:${state.sort.dir}`);
  history.replaceState(null, '', p.toString() ? `?${p}` : location.pathname);
}

function loadUrl() {
  const p = new URLSearchParams(location.search);
  if (p.has('w')) {
    const vals = p.get('w').split(',').map(Number);
    AXES.forEach((a, i) => {
      if (Number.isFinite(vals[i])) state.weights[a.key] = vals[i];
    });
  }
  const f = state.filters;
  for (const [k, raw] of p.entries()) {
    if (k === 'w' || k === 'sort') continue;
    if (k === 'sector') {
      for (const item of raw.split('|')) {
        if (!item) continue;
        const ex = item.startsWith('!');
        f.sector[ex ? item.slice(1) : item] = ex ? 'exclude' : 'include';
      }
    } else if (k === 'markets') {
      f.markets = raw.split(',').filter(Boolean);
    } else if (typeof f[k] === 'boolean') {
      f[k] = raw === 'true';
    } else if (k in f) {
      f[k] = raw === '' ? null : Number.isNaN(Number(raw)) ? raw : Number(raw);
    }
  }
  if (p.has('sort')) {
    const [key, dir] = p.get('sort').split(':');
    if (SORT_VALUE[key]) state.sort = { key, dir: Number(dir) || -1 };
  }
}

/* ── 기타 ─────────────────────────────────────────────── */
function exportCsv() {
  const cols = visibleColumns();
  const head = ['점수', ...cols.filter((c) => c.key !== 'score').map((c) => c.label)];
  const cellOf = (s, key) => {
    switch (key) {
      case 'score': return s._score100;
      case 'name': return s.name;
      case 'capRank': return s.capRank;
      case 'close': return s.close;
      case 'changePct': return s.changePct;
      case 'cap': return s.cap;
      case 'per': return s.per;
      case 'pbr': return s.pbr;
      case 'roe': return s.roe;
      case 'divYield': return s.divYield;
      case 'debt': return s.debt;
      case 'revGrowth': return s.revGrowth;
      case 'ret90': return s.ret?.[90];
      case 'mine': return noteOf(s.code)?.rating;
      case 'qty': return noteOf(s.code)?.qty;
      case 'pl': return position(s)?.pl;
      default: return '';
    }
  };
  const rows = state.view.map((s) => [
    s._score100,
    ...cols.filter((c) => c.key !== 'score').map((c) => cellOf(s, c.key)),
  ]);
  // 종목코드는 앞의 0이 떨어지지 않게 글자로 감싼다
  const esc = (v) => (v == null ? '' : `"${String(v).replace(/"/g, '""')}"`);
  const csv = [['종목코드', ...head], ...state.view.map((s, i) => [s.code, ...rows[i]])]
    .map((r) => r.map(esc).join(','))
    .join('\r\n');
  // 엑셀이 UTF-8로 열도록 BOM 을 붙인다
  download(`주식랭킹-${today()}.csv`, '﻿' + csv, 'text/csv');
  toast(`${nf(state.view.length)}종목을 CSV로 내보냈습니다`);
}

function toast(msg) {
  const t = $('#toast');
  setChildren(t, el('span', { textContent: msg }));
  t.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => (t.hidden = true), 2600);
}

function initTheme() {
  const modes = ['system', 'light', 'dark'];
  const labels = { system: '시스템', light: '밝게', dark: '어둡게' };
  const icons = { system: '◐', light: '☀', dark: '☾' };
  let mode = localStorage.getItem('sl.theme') ?? 'system';

  const apply = () => {
    if (mode === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = mode;
    $('#themeToggle').querySelector('.theme-icon').textContent = icons[mode];
    $('#themeToggle').querySelector('.theme-label').textContent = labels[mode];
    localStorage.setItem('sl.theme', mode);
  };
  apply();
  $('#themeToggle').onclick = () => {
    mode = modes[(modes.indexOf(mode) + 1) % modes.length];
    apply();
  };
}

function initCollapsibles() {
  for (const btn of document.querySelectorAll('.collapse-btn')) {
    const key = `sl.panel.${btn.dataset.panel}`;
    const body = document.getElementById(btn.getAttribute('aria-controls'));
    const set = (open) => {
      btn.setAttribute('aria-expanded', String(open));
      body.hidden = !open;
      localStorage.setItem(key, open ? 'on' : 'off');
    };
    set(localStorage.getItem(key) !== 'off');
    btn.onclick = () => set(btn.getAttribute('aria-expanded') === 'false');
  }
}

/** 필터·가중치·정렬·검색을 처음 상태로 되돌린다. 내 표시·기록은 건드리지 않는다. */
function goHome() {
  state.filters = DEFAULT_FILTERS();
  state.weights = { ...PRESETS[DEFAULT_PRESET] };
  state.sort = { key: 'score', dir: -1 };
  state.compare = [];

  $('#drawer').hidden = true;
  $('#compareView').hidden = true;
  $('#folioView').hidden = true;
  $('#search').value = '';
  $('#compactMode').checked = false;
  document.body.classList.remove('compact');

  buildFilters();
  syncSliders();
  markPreset();
  renderHead();
  refreshCompareUi();
  recompute();
  $('#tableWrap').scrollTop = 0;
}

/* ── 시작 ─────────────────────────────────────────────── */
async function main() {
  initTheme();
  initDrawerResize();

  const res = await fetch(versioned(CONFIG.DATA_URL ?? 'data/stocks.json'));
  if (!res.ok) {
    $('#stamp').textContent = 'data/stocks.json 을 불러오지 못했습니다. npm run sample 이나 npm run sync 를 먼저 실행하세요.';
    return;
  }
  state.data = await res.json();
  attachPercentiles(state.data.stocks);

  loadUrl();

  $('#sampleNotice').hidden = !state.data.sample;
  $('#stamp').textContent = state.data.sample
    ? `예시 데이터 · ${nf(state.data.count)}종목`
    : `${state.data.date} 종가 기준 · ${nf(state.data.count)}종목` +
      (state.data.finYear ? ` · 재무 ${state.data.finYear}년` : '');

  buildPresets();
  buildSliders();
  buildFilters();

  // 열 구성은 renderHead 보다 먼저 정해야 머리글과 본문이 어긋나지 않는다
  state.showNotes = Object.keys(notes).length > 0;
  $('#showNotes').checked = state.showNotes;
  renderHead();
  markPreset();
  initCollapsibles();

  $('#search').value = state.filters.q;

  let searchTimer;
  $('#search').oninput = (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filters.q = e.target.value.trim();
      recompute();
    }, 160);
  };

  $('#showNotes').onchange = (e) => {
    state.showNotes = e.target.checked;
    renderHead();
    recompute();
  };
  $('#myFolio').onclick = openFolio;

  applyViewMode();

  $('#tableWrap').onscroll = (e) => {
    const box = e.target;
    if (box.scrollTop + box.clientHeight > box.scrollHeight - 400) renderMore();
    $('#toTop').hidden = box.scrollTop < 600;
  };
  $('#toTop').onclick = () => $('#tableWrap').scrollTo({ top: 0, behavior: 'smooth' });

  $('#viewMode').onclick = (e) => {
    const btn = e.target.closest('button[data-view]');
    if (!btn || btn.dataset.view === state.viewMode) return;
    state.viewMode = btn.dataset.view;
    applyViewMode();
    recompute();
  };

  // 사이드바를 접으면 표가 화면 전체 폭을 쓴다
  if (localStorage.getItem('sl.sidebar') === 'off') $('#workspace').classList.add('solo');
  $('#sidebarToggle').onclick = () => {
    const solo = $('#workspace').classList.toggle('solo');
    localStorage.setItem('sl.sidebar', solo ? 'off' : 'on');
  };

  // 로고 = 처음 화면. 새로고침 대신 상태만 되돌려 즉시 반응하게 한다.
  $('#homeLink').onclick = (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    goHome();
  };

  $('#compactMode').onchange = (e) => document.body.classList.toggle('compact', e.target.checked);
  $('#copyLink').onclick = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast('현재 필터·가중치가 담긴 링크를 복사했습니다');
    } catch {
      toast('복사에 실패했습니다. 주소창의 주소를 그대로 쓰세요.');
    }
  };
  $('#exportCsv').onclick = exportCsv;
  $('#resetFilters').onclick = () => {
    state.filters = DEFAULT_FILTERS();
    buildFilters();
    $('#search').value = '';
    recompute();
  };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // 위에 떠 있는 것부터 닫는다 (상세 80 > 포트폴리오·비교 70)
      if (!$('#drawer').hidden) {
        $('#drawer').hidden = true;
        document.querySelectorAll('#tableWrap .open').forEach((r) => r.classList.remove('open'));
      } else if (!$('#folioView').hidden) $('#folioView').hidden = true;
      else if (!$('#compareView').hidden) $('#compareView').hidden = true;
    }
    if (e.key === '/' && document.activeElement !== $('#search')) {
      e.preventDefault();
      $('#search').focus();
    }
  });

  recompute();
}

main();
