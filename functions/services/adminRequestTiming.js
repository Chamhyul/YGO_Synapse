'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { uptime } = require('node:process');
const scope = new AsyncLocalStorage();
const MAX_SPANS = 128;
const routes = new Set(['/admin', '/admin/cards', '/admin/notices', '/admin/settings', '/admin/server-logs',
  '/admin/admin-logs', '/admin/api/errors', '/admin/api/traffic', '/admin/api/notices', '/admin/api/notices/preview',
  '/admin/api/membership-csv', '/admin/api/membership-csv/preview', '/admin/api/membership-csv/status',
  '/admin/session', '/admin/session/activity', '/admin/session/logout']);
const stages = new Set(['admin.runtime.select', 'admin.runtime.dependencies', 'admin.auth.initial', 'admin.auth.final',
  'admin.auth.jwt', 'admin.auth.account', 'admin.session.get', 'admin.session.confirm',
  'admin.html', 'admin.html.template', 'admin.html.parse', 'admin.html.serialize',
  'admin.traffic.load', 'admin.traffic.ga', 'admin.traffic.validate', 'admin.traffic.cache', 'admin.traffic.shared', 'admin.traffic.cooldown',
  'journal.read', 'journal.history_lookup', 'journal.route', 'journal.cas', 'record.get', 'record.observe', 'record.decode', 'record.transaction',
  'writer.prepare', 'writer.maintenance', 'writer.executing', 'writer.commit', 'writer.receipt', 'writer.complete', 'writer.receipt_final']);
const failures = new Set(['REPORTS_MISSING', 'REPORT_MISSING', 'TIMEZONE_MISMATCH', 'METRIC_HEADERS', 'DIMENSION_HEADERS',
  'ROW_COUNT', 'SUMMARY_ROWS', 'METRIC_VALUES', 'COUNT_VALUE', 'DATE_VALUE', 'DATE_RANGE', 'SCHEMA_UNEXPECTED',
  'UPSTREAM_SCOPE', 'UPSTREAM_PERMISSION', 'UPSTREAM_DISABLED', 'UPSTREAM_QUOTA', 'UPSTREAM_TIMEOUT',
  'UPSTREAM_NETWORK', 'UPSTREAM_HTTP', 'UPSTREAM_UNKNOWN', 'COOLDOWN']);
const slots = new Set(['current', 'previous', 'trend']);
const round = n => Math.round(Math.max(0, n) * 1000) / 1000;
const firstRequests = new Set();

// 임의 URL·입력·오류 원문을 로그에 넘기지 않고 고정 관리자 경로만 선택한다.
function routeOf(operation, req) {
  try {
    const url = new URL(req.originalUrl || req.url || '', 'https://admin.invalid');
    const selected = operation === 'adminBackend' ? url.searchParams.get('route') : url.pathname;
    const route = typeof selected === 'string' ? selected.replace(/\/$/, '') || '/' : '';
    return routes.has(route) ? route : null;
  } catch (_) { return null; }
}
function measure(name, action) {
  const active = scope.getStore();
  if (!active || active.request.finished || !stages.has(name)) return action();
  const request = active.request;
  if (request.spans.length >= MAX_SPANS) { request.dropped++; return action(); }
  const span = { id: request.spans.length + 1, parent: active.parent, name, startMs: round(performance.now() - request.started) };
  request.spans.push(span);
  const at = performance.now(), finish = ok => { span.durationMs = round(performance.now() - at); span.ok = ok; };
  return scope.run({ request, parent: span.id }, () => {
    try {
      const value = action();
      if (value && typeof value.then === 'function') return Promise.resolve(value).then(
        result => { finish(true); return result; }, error => { finish(false); throw error; });
      finish(true); return value;
    } catch (error) { finish(false); throw error; }
  });
}
function recordTrafficFailure(detail) {
  try {
    const request = scope.getStore()?.request;
    if (!request || request.finished || request.trafficFailures.length >= 2) return;
    const safe = { category: failures.has(detail?.category) ? detail.category : 'UPSTREAM_UNKNOWN' };
    if (slots.has(detail?.report)) safe.report = detail.report;
    if (Number.isInteger(detail?.httpStatus) && detail.httpStatus >= 100 && detail.httpStatus <= 599) safe.httpStatus = detail.httpStatus;
    // Intl이 해석한 실제 IANA 시간대만 허용한다. 임의 문자열은 내보내지 않는다.
    if (typeof detail?.timeZone === 'string' && detail.timeZone.length <= 64) {
      try { safe.timeZone = new Intl.DateTimeFormat('en', { timeZone: detail.timeZone }).resolvedOptions().timeZone; }
      catch (_) { safe.timeZone = 'invalid'; }
    } else if (detail?.category === 'TIMEZONE_MISMATCH') safe.timeZone = 'missing';
    request.trafficFailures.push(safe);
  } catch (_) { /* 관측 실패는 업무 처리에 전파하지 않는다. */ }
}
// 응답 값/사용자 차원은 수집하지 않고 허용된 열의 이름·순서·유형만 최대3개 보고서에 기록한다.
function recordTrafficSchema(report, value) {
  try {
    const request = scope.getStore()?.request;
    if (!request || request.finished || !slots.has(report) || request.trafficSchemas.length >= 3) return;
    const names = new Set(['activeUsers', 'sessions', 'screenPageViews', 'date']);
    const types = new Set(['TYPE_INTEGER', 'TYPE_FLOAT', 'TYPE_SECONDS', 'TYPE_MILLISECONDS', 'TYPE_MINUTES', 'TYPE_HOURS', 'TYPE_STANDARD', 'TYPE_CURRENCY']);
    const headers = values => !Array.isArray(values) ? null : values.slice(0, 8).map(header => ({
      name: names.has(header?.name) ? header.name : header?.name == null ? 'missing' : 'other',
      type: types.has(header?.type) ? header.type : header?.type == null ? 'missing' : 'other'
    }));
    request.trafficSchemas.push({ report, metricHeaders: headers(value?.metricHeaders), dimensionHeaders: headers(value?.dimensionHeaders),
      metricHeadersState: value?.metricHeaders === undefined ? 'absent' : Array.isArray(value.metricHeaders) ? value.metricHeaders.length ? 'nonempty' : 'empty' : 'invalid',
      dimensionHeadersState: value?.dimensionHeaders === undefined ? 'absent' : Array.isArray(value.dimensionHeaders) ? value.dimensionHeaders.length ? 'nonempty' : 'empty' : 'invalid',
      kindValid: value?.kind === 'analyticsData#runReport',
      rowsState: value?.rows === undefined ? 'absent' : Array.isArray(value.rows) ? value.rows.length ? 'nonempty' : 'empty' : 'invalid',
      rowCountState: value?.rowCount === undefined ? 'absent' : value.rowCount === 0 ? 'zero' : Number.isInteger(value.rowCount) && value.rowCount > 0 ? 'positive' : 'invalid',
      emptyReasonPresent: typeof value?.metadata?.emptyReason === 'string' && value.metadata.emptyReason.length > 0,
      metricHeaderCount: Array.isArray(value?.metricHeaders) ? value.metricHeaders.length : null,
      dimensionHeaderCount: Array.isArray(value?.dimensionHeaders) ? value.dimensionHeaders.length : null });
  } catch (_) { /* 관측 실패는 업무 처리에 전파하지 않는다. */ }
}
function withAdminRequestTiming(operation, handler, { emit = line => console.log(line) } = {}) {
  if (!['adminPages', 'adminBackend'].includes(operation)) throw Error('Invalid admin timing operation');
  return (req, res) => {
    const route = routeOf(operation, req), method = req.method;
    if (!route || !['GET', 'HEAD', 'POST'].includes(method)) return handler(req, res);
    const first = !firstRequests.has(operation); firstRequests.add(operation);
    const request = { started: performance.now(), spans: [], trafficFailures: [], trafficSchemas: [], dropped: 0, finished: false };
    const requestId = randomBytes(12).toString('hex'), processAgeMs = round(uptime() * 1000);
    function finish(completed) {
      if (request.finished) return; request.finished = true;
      try { emit(JSON.stringify({ severity: 'INFO', event: 'admin_request_timing', version: 1, operation, route,
        method, requestId, firstTimedRequest: first, processAgeMs,
        status: Number.isInteger(res.statusCode) ? res.statusCode : 0, completed,
        totalMs: round(performance.now() - request.started), droppedSpans: request.dropped,
        spans: request.spans.map(span => ({ ...span })), trafficFailures: request.trafficFailures.map(value => ({ ...value })), trafficSchemas: request.trafficSchemas.map(value => ({ ...value })) })); }
      catch (_) { /* 로그 출력 실패도 응답·복구 경계를 바꾸지 않는다. */ }
    }
    let observable = false;
    if (typeof res.once === 'function') {
      try { res.once('finish', () => finish(true)); res.once('close', () => finish(false)); observable = true; }
      catch (_) { /* 합성 응답이나 관측 등록 실패는 반환 시점에 마무리한다. */ }
    }
    return scope.run({ request, parent: 0 }, async () => {
      try { return await handler(req, res); }
      finally { if (!observable) finish(true); }
    });
  };
}
module.exports = { measure, recordTrafficFailure, recordTrafficSchema, withAdminRequestTiming, MAX_SPANS };
