/**
 * data/prices.json + data/financials.json → data/stocks.json
 *
 * 화면이 읽는 파일은 이것 하나뿐이다. 여기서 하는 일은 두 가지다.
 *
 *  1. 시세와 재무를 종목코드로 엮는다.
 *  2. PER·PBR·ROE 같은 파생 지표를 **여기서 한 번만** 계산한다.
 *     브라우저에서 2,600종목 × 10지표를 매번 다시 계산할 이유가 없고,
 *     계산식이 한 곳에 모여 있어야 화면에서 "왜 이 값인지"를 설명할 수 있다.
 *
 * 재무가 없는 종목(신규상장·리츠·스팩 등)도 버리지 않는다.
 * 값이 없는 칸은 null 로 두고, 점수 계산에서는 중앙값으로 친다.
 */
import { readJson, writeJson, div } from './lib.mjs';

/** 소수 n자리에서 반올림. null 은 그대로 통과. */
const round = (v, n = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** n) / 10 ** n);

/**
 * 증가율(%). 기준이 적자(음수)면 계산하지 않는다.
 *
 * -100억에서 -50억이 된 것을 "+50% 성장"이라고 부를 수는 없다.
 * 부호가 바뀌는 구간에서 증가율은 뜻을 잃으므로 아예 비워 둔다.
 */
function growth(now, prev) {
  if (now == null || prev == null || prev <= 0) return null;
  return ((now - prev) / prev) * 100;
}

async function main() {
  const prices = await readJson('data/prices.json');
  if (!prices) {
    console.error('data/prices.json 이 없습니다. npm run sync:prices 를 먼저 실행하세요.');
    process.exit(1);
  }
  const fin = await readJson('data/financials.json');
  if (!fin) console.warn('data/financials.json 이 없습니다 — PER·PBR·ROE 없이 빌드합니다.');

  const finOf = fin?.stocks ?? {};
  const stocks = [];

  for (const s of prices.stocks) {
    const f = finOf[s.code];
    const cap = s.cap ?? null;

    // 적자면 PER 이 음수가 되는데, "PER 이 낮아서 싸다"는 해석이 통하지 않는다.
    // 그래서 순이익이 0 이하면 PER 을 비워 두고 화면에서 '적자'로 표시한다.
    /*
     * div() 는 값이 없으면 null 을 준다. 여기에 그대로 * 100 을 하면 null * 100 === 0
     * 이라 "자료 없음"이 "0%"로 둔갑한다. ROE 0% 와 ROE 모름은 전혀 다른 이야기이므로
     * 백분율은 곱하기 전에 null 을 걸러낸다.
     */
    const times100 = (v) => (v == null ? null : v * 100);

    const per = f && f.netIncome > 0 ? div(cap, f.netIncome) : null;
    const pbr = f && f.equity > 0 ? div(cap, f.equity) : null;
    const roe = f && f.equity > 0 ? times100(div(f.netIncome, f.equity)) : null;
    const psr = f && f.revenue > 0 ? div(cap, f.revenue) : null;
    const opm = f && f.revenue > 0 ? times100(div(f.operatingIncome, f.revenue)) : null;
    const debt = f && f.equity > 0 ? times100(div(f.liabilities, f.equity)) : null;
    const divYield = f?.dps && s.close ? (f.dps / s.close) * 100 : null;
    // 배당성향 — 번 돈 중 얼마를 나눠 줬나. 100%를 넘으면 이익보다 많이 준 것이다.
    const payout =
      f?.dps && f.netIncome > 0 && s.shares ? ((f.dps * s.shares) / f.netIncome) * 100 : null;

    stocks.push({
      code: s.code,
      name: s.name,
      market: s.market,
      sector: s.sector ?? null,
      kind: s.kind ?? null,
      listedOn: s.listedOn ?? null,

      close: s.close,
      change: s.change,
      changePct: s.changePct,
      high: s.high,
      low: s.low,
      volume: s.volume,
      value: s.value,
      cap,
      capRank: s.capRank,
      shares: s.shares,
      ret: s.ret ?? {},

      // 재무 원자료 — 화면에서 계산 근거를 그대로 보여 주기 위해 함께 싣는다
      fin: f
        ? {
            year: f.year,
            fs: f.fs,
            revenue: f.revenue,
            operatingIncome: f.operatingIncome,
            netIncome: f.netIncome,
            assets: f.assets,
            liabilities: f.liabilities,
            equity: f.equity,
            dps: f.dps,
          }
        : null,

      per: round(per),
      pbr: round(pbr),
      psr: round(psr),
      roe: round(roe),
      opm: round(opm),
      debt: round(debt, 1),
      divYield: round(divYield),
      payout: round(payout, 1),
      revGrowth: round(growth(f?.revenue, f?.prevRevenue), 1),
      profitGrowth: round(growth(f?.netIncome, f?.prevNetIncome), 1),
    });
  }

  /** 화면의 업종 칩에 쓸 목록 — 많은 순으로 */
  const sectors = {};
  for (const s of stocks) if (s.sector) sectors[s.sector] = (sectors[s.sector] ?? 0) + 1;

  const withFin = stocks.filter((s) => s.fin).length;
  const withPer = stocks.filter((s) => s.per != null).length;
  const withDiv = stocks.filter((s) => s.divYield != null).length;

  await writeJson('data/stocks.json', {
    date: prices.date,
    finYear: fin?.year ?? null,
    sources: [prices.source, fin?.source].filter(Boolean),
    count: stocks.length,
    sectors,
    stocks,
  });

  console.log(
    [
      `data/stocks.json — ${stocks.length.toLocaleString('ko-KR')}종목 (${prices.date} 기준)`,
      `  재무 있음 ${withFin.toLocaleString('ko-KR')} · PER 산출 ${withPer.toLocaleString('ko-KR')} · 배당 ${withDiv.toLocaleString('ko-KR')}`,
      `  업종 ${Object.keys(sectors).length}종`,
    ].join('\n'),
  );
}

await main();
