// 공용 유틸: HTTP, ZIP 풀기, 동시성 제어, 거래일 계산
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

export const UA =
  'StockRankingLab/1.0 (personal stock screening site; contact: sungmin182@gmail.com)';

/**
 * 응답이 오지 않는 요청을 끊는 시간(ms).
 *
 * Node의 fetch는 기본 타임아웃이 없다. 연결 하나가 물리면 그 워커는 영원히
 * 기다리고, 동시 실행이 전부 물리면 수집 전체가 아무 로그 없이 멈춘다.
 * DART의 corpCode.xml 은 수 MB짜리 zip 이라 넉넉히 잡는다.
 */
const TIMEOUT_MS = 60_000;

/** 지수 백오프 재시도가 붙은 fetch. asText 면 본문을 글자로, asBuf 면 바이트로 준다. */
export async function get(url, { retries = 4, asText = false, asBuf = false, headers = {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 429 || res.status >= 500) {
        const err = new Error(`HTTP ${res.status}`);
        const after = Number(res.headers.get('retry-after'));
        if (Number.isFinite(after) && after > 0) err.retryAfterMs = after * 1000;
        err.throttled = res.status === 429;
        throw err;
      }
      if (!res.ok) {
        // 4xx 는 재시도해도 같은 답이 온다. 본문에 이유가 적혀 있으므로 같이 던진다.
        const body = await res.text().catch(() => '');
        const err = new Error(`HTTP ${res.status} for ${url}\n${body.slice(0, 300)}`);
        err.status = res.status;
        err.body = body;
        throw err;
      }
      if (asBuf) return Buffer.from(await res.arrayBuffer());
      return asText ? await res.text() : await res.json();
    } catch (err) {
      lastErr = err;
      if (err.status && err.status >= 400 && err.status < 500) throw err;
      if (attempt === retries) break;
      const base = err.throttled ? 4000 : 500;
      await sleep(err.retryAfterMs ?? base * 2 ** attempt + Math.random() * 300);
    }
  }
  throw lastErr;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 최대 limit개를 동시에 실행하며 순서대로 결과를 반환 */
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJson(file, data) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(data), 'utf8');
}

/**
 * ZIP 한 개에서 첫 파일을 꺼낸다.
 *
 * DART의 고유번호 목록(corpCode.xml)이 zip 으로만 나오는데, 이것 하나 때문에
 * 의존성을 추가하고 싶지 않았다. ZIP 로컬 헤더는 구조가 단순하고
 * 압축 방식도 deflate(8) 아니면 무압축(0)뿐이라 node:zlib 로 충분하다.
 */
export function unzipFirst(buf) {
  // 로컬 파일 헤더 시그니처: 0x04034b50
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error('ZIP 파일이 아닙니다');
  const method = buf.readUInt16LE(8);
  const compressedSize = buf.readUInt32LE(18);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const start = 30 + nameLen + extraLen;

  /*
   * 스트리밍으로 만든 zip 은 로컬 헤더의 크기가 0 이고 실제 크기는 파일 뒤쪽
   * 데이터 디스크립터에 적힌다. 그 경우 다음 시그니처 앞까지를 통째로 넘긴다
   * (inflateRaw 는 뒤에 붙은 쓰레기를 무시한다).
   */
  const end = compressedSize > 0 ? start + compressedSize : buf.length;
  const slice = buf.subarray(start, end);
  return method === 0 ? slice : zlib.inflateRawSync(slice);
}

/** YYYYMMDD */
export const ymd8 = (d) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

/** YYYY-MM-DD */
export const ymd = (d) => `${ymd8(d).slice(0, 4)}-${ymd8(d).slice(4, 6)}-${ymd8(d).slice(6)}`;

export function daysAgo(n, from = new Date()) {
  const d = new Date(from);
  d.setDate(d.getDate() - n);
  return d;
}

/** 토·일이면 직전 금요일로 당긴다. 공휴일은 여기서 모르므로 빈 응답으로 판별한다. */
export function lastWeekday(d = new Date()) {
  const out = new Date(d);
  while (out.getDay() === 0 || out.getDay() === 6) out.setDate(out.getDate() - 1);
  return out;
}

/** 0으로 나누기와 null 을 한 곳에서 막는다 */
export const div = (a, b) => (a == null || b == null || !b ? null : a / b);

export const num = (v) => {
  if (v == null) return null;
  // KRX·DART 는 숫자를 "1,234,567" 같은 글자로 준다. "-" 는 값 없음이다.
  const s = String(v).replace(/,/g, '').trim();
  if (s === '' || s === '-' || s === 'N/A') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
