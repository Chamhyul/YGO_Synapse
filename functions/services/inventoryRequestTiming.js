'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { uptime } = require('node:process');
const context = new AsyncLocalStorage();
const MAX_SPANS = 192;
const stages = new Set([
  'storage.initialize', 'auth.verify', 'auth.id_token', 'auth.app_check', 'registration.check',
  'registration.route_before', 'registration.profile_read', 'registration.route_after', 'registration.profile_recheck',
  'card.resolve_number', 'card.resolve_cids', 'inventory.update', 'inventory.snapshot', 'inventory.publish',
  'writer.prepare', 'writer.maintenance', 'writer.executing', 'writer.commit', 'writer.receipt', 'writer.complete', 'writer.receipt_final',
  'journal.read', 'journal.cas', 'journal.route', 'record.get', 'record.observe', 'record.decode', 'record.transaction',
  'inventory.native_read', 'inventory.receipt_lookup', 'inventory.stage_blobs', 'inventory.head_cas',
]);
const round = value => Math.round(Math.max(0, value) * 1000) / 1000;
let firstRequest = true;

// 이름은 고정 목록만 사용한다. 인수·반환값·오류·사용자/작업 ID·DB 경로는 수집하지 않는다.
function measure(name, work) {
  const active = context.getStore();
  if (!active || active.request.finished || !stages.has(name)) return work();
  const request = active.request;
  if (request.spans.length >= MAX_SPANS) { request.dropped++; return work(); }
  const span = { id: request.spans.length + 1, parent: active.parent, name,
    startMs: round(performance.now() - request.started) };
  request.spans.push(span);
  const started = performance.now();
  const finish = ok => { span.durationMs = round(performance.now() - started); span.ok = ok; };
  return context.run({ request, parent: span.id }, () => {
    try {
      const result = work();
      if (result && typeof result.then === 'function') return Promise.resolve(result).then(
        value => { finish(true); return value; }, error => { finish(false); throw error; });
      finish(true); return result;
    } catch (error) { finish(false); throw error; }
  });
}

function withInventoryRequestTiming(operation, handler, { emit = line => console.log(line) } = {}) {
  if (!['addCards', 'discardCards', 'moveCards'].includes(operation)) throw new Error('Invalid timing operation');
  return (req, res) => {
    if (req.method !== 'POST') return handler(req, res);
    const request = { started: performance.now(), spans: [], dropped: 0, finished: false };
    const requestId = randomBytes(12).toString('hex');
    const first = firstRequest; firstRequest = false;
    const processAgeMs = round(uptime() * 1000);
    function finish(completed) {
      if (request.finished) return;
      request.finished = true;
      // 계측 출력 실패가 성공 응답이나 복구 경계를 바꾸지 않는다.
      try { emit(JSON.stringify({ severity: 'INFO', event: 'inventory_request_timing', version: 1,
        operation, requestId, firstTimedRequest: first, processAgeMs,
        status: Number.isInteger(res.statusCode) ? res.statusCode : 0, completed,
        totalMs: round(performance.now() - request.started), droppedSpans: request.dropped,
        spans: request.spans.map(span => ({ ...span })) })); } catch (_) { /* 관측 실패를 업무에 전파하지 않는다. */ }
    }
    const observable = typeof res.once === 'function';
    if (observable) { res.once('finish', () => finish(true)); res.once('close', () => finish(false)); }
    return context.run({ request, parent: 0 }, async () => {
      try { return await handler(req, res); }
      finally { if (!observable) finish(true); }
    });
  };
}

module.exports = { measure, withInventoryRequestTiming, MAX_SPANS };
