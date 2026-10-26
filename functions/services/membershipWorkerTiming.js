'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');
const { cpuUsage, uptime } = require('node:process');
const { isManagedMembershipWorker: managedWorker } = require('./membershipWorkerPreparation');
const scope = new AsyncLocalStorage();
const MAX_SPANS = 192;
const stages = new Set([
  'worker.event_decode', 'worker.runtime', 'worker.route', 'worker.sync', 'worker.retry_wait',
  'worker.config', 'worker.connection', 'worker.services', 'worker.auth',
  'worker.binding_module', 'worker.firestore_types', 'worker.binding',
  'login.binding', 'journal.route', 'journal.read', 'journal.history_lookup', 'journal.cas',
  'record.get', 'record.observe', 'record.decode', 'record.transaction',
  'claims.route_before', 'claims.route_after', 'claims.lock_before', 'claims.lock_after',
  'claims.source', 'claims.source_after', 'claims.account', 'claims.settled',
  'claims.acquire', 'claims.patch', 'claims.readback', 'claims.finish', 'claims.after_write', 'claims.event_write',
]);
const statuses = new Set(['synced', 'pending', 'unchanged']);
const round = n => Math.round(Math.max(0, n) * 1000) / 1000;
let first = true;
let startupPreparedAt;

// 일반 HTTP·배포 탐색·에뮬레이터에서 운영 연결을 미리 만들지 않는다.
function prepareMembershipWorkerStartup(select, { env = process.env,
  emit = value => console.log(JSON.stringify(value)) } = {}) {
  if (!managedWorker(env)) return;
  const request = { started: performance.now(), spans: [], dropped: 0, finished: false };
  const cpu = cpuUsage(); let status = 'failed';
  try {
    const runtime = scope.run({ request, parent: 0 }, () => measure('worker.runtime', select));
    // 모듈 로드의 동기 준비만 허용한다. 백그라운드 초기화나 route/Auth 관측은 없다.
    if (runtime && typeof runtime.then === 'function') Promise.resolve(runtime).catch(() => {});
    if (!runtime?.storage?.writerTransition || runtime.config?.mode !== 'production') {
      throw Object.assign(new Error('worker의 운영 초기 구성을 확인하지 못했습니다.'),
        { code: 'MEMBERSHIP_WORKER_STARTUP_INVALID' });
    }
    startupPreparedAt = performance.now(); status = 'prepared';
    return runtime;
  } finally {
    request.finished = true;
    try {
      const used = cpuUsage(cpu);
      emit({ event: 'membership_worker_startup_timing', version: 1, status,
        processAgeMs: round(uptime() * 1000), totalMs: round(performance.now() - request.started),
        processCpuUserMs: round(used.user / 1000), processCpuSystemMs: round(used.system / 1000),
        droppedSpans: request.dropped, spans: request.spans.map(span => ({ ...span })) });
    } catch (_) { /* 계측 실패로 초기화 결과를 바꾸지 않는다. */ }
  }
}

// 공통 runtime의 단계는 worker의 기동/실행 문맥에만 기록한다.
function measureInitialization(name, work) { return scope.getStore() ? measure(name, work) : work(); }

// 사용자/이벤트 식별자·원문·오류 내용은 받지 않는다. 관측은 업무를 재실행하지 않는다.
function mark(status, attempts = 0) {
  const request = scope.getStore()?.request;
  if (request && !request.finished && statuses.has(status)) {
    request.status = status;
    if (Number.isInteger(attempts) && attempts >= 0 && attempts <= 4) request.attempts = attempts;
  }
}
function measure(name, work) {
  const active = scope.getStore();
  if (!active) return require('./adminRequestTiming').measure(name, work);
  const request = active.request;
  if (request.finished || !stages.has(name)) return work();
  if (request.spans.length >= MAX_SPANS) { request.dropped++; return work(); }
  const started = performance.now();
  const span = { id: request.spans.length + 1, parent: active.parent, name,
    startMs: round(started - request.started) };
  request.spans.push(span);
  const finish = ok => { span.durationMs = round(performance.now() - started); span.ok = ok; };
  return scope.run({ request, parent: span.id }, () => {
    try {
      const result = work();
      if (result && typeof result.then === 'function') return Promise.resolve(result).then(
        value => { finish(true); return value; }, error => { finish(false); throw error; });
      finish(true); return result;
    } catch (error) { finish(false); throw error; }
  });
}
function withMembershipWorkerTiming(handler, { emit = value => console.log(JSON.stringify(value)) } = {}) {
  return async event => {
    const request = { started: performance.now(), spans: [], dropped: 0, status: 'failed', attempts: 0,
      firstTimedRequest: first, processAgeMs: round(uptime() * 1000), finished: false };
    first = false;
    const cpu = cpuUsage();
    return scope.run({ request, parent: 0 }, async () => {
      try { return await handler(event); }
      catch (error) { if (request.status !== 'pending') request.status = 'failed'; throw error; }
      finally {
        request.finished = true;
        try {
          const used = cpuUsage(cpu);
          emit({ event: 'membership_worker_timing', version: 1, status: request.status,
            firstTimedRequest: request.firstTimedRequest, processAgeMs: request.processAgeMs,
            startupPrepared: startupPreparedAt !== undefined,
            ...(startupPreparedAt === undefined ? {} : { startupAgeMs: round(request.started - startupPreparedAt) }),
            totalMs: round(performance.now() - request.started), attempts: request.attempts,
            processCpuUserMs: round(used.user / 1000), processCpuSystemMs: round(used.system / 1000),
            droppedSpans: request.dropped, spans: request.spans.map(span => ({ ...span })) });
        } catch (_) { /* 계측 장애로 성공·실패·영속 재배달 결과를 바꾸지 않는다. */ }
      }
    });
  };
}
module.exports = { measure, mark, withMembershipWorkerTiming, MAX_SPANS,
  prepareMembershipWorkerStartup, measureInitialization, isManagedMembershipWorker: managedWorker };
