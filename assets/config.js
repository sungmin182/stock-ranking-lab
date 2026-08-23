/**
 * 사이트 설정.
 *
 * LIVE_PROXY
 *   KRX 오픈API 는 요청 헤더에 인증키(AUTH_KEY)를 요구합니다. 브라우저에서
 *   직접 부르면 그 키가 개발자도구에 그대로 드러나므로 — 공개 저장소에
 *   올라가는 사이트에서는 절대 하면 안 됩니다 — "지금 이 순간 시세"를
 *   보려면 키를 대신 들고 있는 얇은 중계 서버가 하나 필요합니다.
 *
 *   proxy/worker.js 를 Cloudflare Workers 에 배포하고(무료) 발급된 주소를
 *   여기에 넣으면 상세 패널에 '실시간 새로고침' 버튼이 나타납니다.
 *
 *   비워두면 사이트는 매일 갱신되는 data/stocks.json 만으로 정상 동작합니다.
 */
window.SL_CONFIG = {
  LIVE_PROXY: '',
  DATA_URL: 'data/stocks.json',

  /**
   * 상세 패널의 바깥 사이트 바로가기.
   *
   * {code} 자리에 6자리 종목코드, {q} 자리에 종목명이 들어갑니다.
   *
   * ── 왜 여기 모아 두었나 ──────────────────────────────
   * 주소 형식이 바뀌었을 때 코드가 아니라 이 한 줄만 고치면 되게 하려는 것입니다.
   * 고치는 방법은 간단합니다. 그 사이트에서 종목 하나를 연 뒤 주소창의 주소를
   * 붙여넣고, 종목코드 부분만 {code} 로 바꾸면 됩니다.
   */
  LINKS: {
    naver: {
      label: '네이버 증권',
      url: 'https://finance.naver.com/item/main.naver?code={code}',
      mobile: 'https://m.stock.naver.com/domestic/stock/{code}/total',
    },
    dart: {
      label: 'DART 공시',
      // 종목코드로 바로 검색되는 공시 목록. 회사 고유번호를 몰라도 열린다.
      url: 'https://dart.fss.or.kr/dsab007/main.do?textCrpNm={q}',
    },
    kind: {
      label: 'KIND 기업정보',
      url: 'https://kind.krx.co.kr/common/searchcorpname.do?method=searchCorpNameSub&forward=&searchCodeType=char&searchCorpName={q}',
    },
    krx: {
      label: 'KRX 종목시세',
      url: 'http://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201020101',
    },
  },
};
