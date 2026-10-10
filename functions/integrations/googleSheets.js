// 공개·링크 공유 시트만 익명으로 읽는다. ADC·서비스 계정·사용자 토큰을 사용하지 않는다.
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 50000;
const accessError = () => Object.assign(new Error('공개·링크 공유 및 다운로드 허용 설정을 확인해 주세요.'), { code: 'PUBLIC_SHEET_NO_ACCESS' });
const unavailableError = () => Object.assign(new Error('시트를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.'), { code: 'PUBLIC_SHEET_UNAVAILABLE' });
const invalidError = message => Object.assign(new Error(message), { code: 'INVALID_IMPORT' });

function sheetsIsValidSpreadsheetId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{25,200}$/.test(id);
}

function isAllowedDownloadUrl(url) {
  return url.protocol === 'https:' && !url.username && !url.password && !url.port
    && (url.hostname === 'docs.google.com'
      || /^doc-[a-z0-9-]+-sheets\.googleusercontent\.com$/.test(url.hostname));
}

async function readAnonymousResponse(url, signal, allowDownloadRedirect = false) {
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetch(url, { method: 'GET', credentials: 'omit', redirect: 'manual',
      cache: 'no-store', signal, headers: { Accept: allowDownloadRedirect ? 'text/csv' : 'text/html' } });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      if (!allowDownloadRedirect || redirects === 3) throw accessError();
      let next;
      try { next = new URL(response.headers.get('location'), url); } catch (_) { throw accessError(); }
      if (!isAllowedDownloadUrl(next)) throw accessError();
      url = next;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw [401, 403, 404].includes(response.status) ? accessError() : unavailableError();
    }
    const length = Number(response.headers.get('content-length'));
    if (length > MAX_BYTES) {
      await response.body?.cancel();
      throw invalidError('시트 데이터가 8MiB를 초과했습니다. 파일로 나누어 가져와 주세요.');
    }
    if (!response.body) throw unavailableError();
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw invalidError('시트 데이터가 8MiB를 초과했습니다. 파일로 나누어 가져와 주세요.');
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let body;
      try { body = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch (_) { throw invalidError('시트의 문자 인코딩을 확인해 주세요.'); }
      return { body, contentType: response.headers.get('content-type') || '' };
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  throw accessError();
}

function findMyCardGid(html) {
  // Google 공개 htmlview의 탭 메타데이터에서 이름·숫자 ID만 추출한다. 스크립트/URL은 실행하지 않는다.
  const tabs = [...html.matchAll(/items\.push\(\{\s*name:\s*("(?:\\.|[^"\\])*"),\s*pageUrl:\s*"(?:\\.|[^"\\])*",\s*gid:\s*"(-?\d+)"\s*,/g)];
  if (!tabs.length) throw accessError();
  const matches = tabs.filter(match => {
    try { return JSON.parse(match[1]) === 'MyCard'; } catch (_) { return false; }
  });
  if (matches.length !== 1) throw invalidError('MyCard 시트를 확인해 주세요.');
  return matches[0][2];
}

function parsePublicSheetCsv(input) {
  const source = input.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', quoted = false, endedQuote = false, column = 0;
  const cell = () => { if (column < 26) row.push(field); column++; field = ''; endedQuote = false; };
  const line = () => {
    cell(); rows.push(row); row = []; column = 0;
    if (rows.length > MAX_ROWS + 1) throw invalidError('시트 데이터가 50,000행을 초과했습니다. 파일로 나누어 가져와 주세요.');
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (source[i + 1] === '"') { field += '"'; i++; }
      else { quoted = false; endedQuote = true; }
    } else if (ch === ',') cell();
    else if (ch === '\r' || ch === '\n') { line(); if (ch === '\r' && source[i + 1] === '\n') i++; }
    else if (ch === '"' && !field && !endedQuote) quoted = true;
    else if (endedQuote && /[ \t]/.test(ch)) continue;
    else if (endedQuote || ch === '"') throw invalidError('시트 CSV 형식을 확인해 주세요.');
    else field += ch;
  }
  if (quoted) throw invalidError('시트 CSV 형식을 확인해 주세요.');
  if (field || row.length || column || endedQuote) line();
  return rows;
}

async function sheetsReadPublicMyCardRows(spreadsheetId) {
  if (!sheetsIsValidSpreadsheetId(spreadsheetId)) throw invalidError('올바른 시트 ID가 필요합니다.');
  const signal = AbortSignal.timeout(20000);
  const base = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
  try {
    const metadata = await readAnonymousResponse(new URL(`${base}/htmlview`), signal);
    if (!/^text\/html\b/i.test(metadata.contentType)) throw unavailableError();
    const gid = findMyCardGid(metadata.body);
    // gviz는 열 자료형을 추론하므로 사용하지 않는다. 원래 셀 값을 보존하는 CSV를 내려받는다.
    const csv = await readAnonymousResponse(new URL(`${base}/export?format=csv&gid=${gid}`), signal, true);
    if (/^text\/html\b/i.test(csv.contentType) || /^\s*<(?:!doctype|html)/i.test(csv.body)) throw accessError();
    if (!/^(?:text\/csv|application\/(?:csv|octet-stream))\b/i.test(csv.contentType)) throw unavailableError();
    return parsePublicSheetCsv(csv.body);
  } catch (error) {
    if (['INVALID_IMPORT', 'PUBLIC_SHEET_NO_ACCESS', 'PUBLIC_SHEET_UNAVAILABLE'].includes(error.code)) throw error;
    throw unavailableError();
  }
}

module.exports = { sheetsIsValidSpreadsheetId, sheetsReadPublicMyCardRows };
