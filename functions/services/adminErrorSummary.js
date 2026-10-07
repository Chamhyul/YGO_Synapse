/** Error Reporting 원본 메시지·계정·URL·그룹 식별자는 응답/로그에 전달하지 않는다. */
const CACHE_MS = 60000;
const PERIOD = 'PERIOD_1_DAY';
function countOf(value) {
  if (!/^\d+$/.test(String(value))) throw new Error('invalid-count');
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error('invalid-count');
  return n;
}
function normalizeGroup(group) {
  const message = typeof group.representative?.message === 'string' ? group.representative.message : '';
  // 고정된 분류명만 반환한다. 원본에서 임의 문자열을 추출하지 않는다.
  const description = /timeout|timed out|deadline exceeded/i.test(message) ? '처리 시간 초과'
    : /ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up/i.test(message) ? '외부 서비스 연결 실패'
    : /RESOURCE_EXHAUSTED|quota exceeded|rate limit/i.test(message) ? '요청 한도 초과'
    : '분류되지 않은 오류';
  const services = (group.affectedServices || []).map(s => String(s.service || '').toLowerCase());
  const feature = services.some(s => /membership|discord|integration/.test(s)) ? '외부 연동'
    : services.some(s => /illustration|photo/.test(s)) ? '이미지 처리'
    : services.some(s => /notice/.test(s)) ? '공지 관리'
    : services.some(s => /card|crawl|pack/.test(s)) ? '카드 데이터 처리'
    : '서버 처리';
  const last = Date.parse(group.lastSeenTime);
  return { description, feature, count: countOf(group.count), lastSeen: Number.isFinite(last) ? new Date(last).toISOString() : null };
}
function createErrorSummaryService({ list, now = Date.now }) {
  let cached; let pending; let retryAt = 0;
  async function load() {
    const started = now(); let token; let pages = 0; let begin; const groups = []; const tokens = new Set();
    do {
      if (now() - started > 15000) throw new Error('query-timeout');
      const result = await list({ period: PERIOD, pageToken: token });
      if (result.timeRangeBegin) begin ||= result.timeRangeBegin;
      groups.push(...(result.errorGroupStats || []).map(normalizeGroup));
      token = result.nextPageToken; pages++;
      if (token && tokens.has(token)) throw new Error('repeated-page');
      if (token) tokens.add(token);
    } while (token && pages < 5);
    const count = groups.reduce((total, group) => total + group.count, 0);
    if (!Number.isSafeInteger(count)) throw new Error('invalid-total');
    const beginMs = Date.parse(begin);
    if (!Number.isFinite(beginMs)) throw new Error('missing-period');
    const queriedAt = now();
    return { periodHours: 24, scope: 'Cloud Run · Error Reporting',
      periodStart: new Date(beginMs).toISOString(), queriedAt: new Date(queriedAt).toISOString(),
      cacheSeconds: CACHE_MS / 1000, partial: !!token,
      occurrenceCount: count, groupCount: groups.length,
      topErrors: groups.sort((a, b) => b.count - a.count).slice(0, 5) };
  }
  return async function getSummary() {
    if (cached && now() - cached.time < CACHE_MS) return cached.value;
    if (pending) return pending;
    if (now() < retryAt) throw new Error('query-cooldown');
    pending = load().then(value => { cached = { value, time: now() }; return value; })
      .catch(() => { retryAt = now() + 10000; throw new Error('error-summary-unavailable'); })
      .finally(() => { pending = null; });
    return pending;
  };
}
module.exports = { createErrorSummaryService, normalizeGroup, CACHE_MS };
