'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { uptime } = require('node:process');
const context = new AsyncLocalStorage();
const MAX_SPANS = 192;
const stages = new Set([
  'storage.initialize', 'auth.verify', 'auth.id_token', 'auth.account', 'auth.app_check', 'registration.check',
  'registration.route_before', 'registration.profile_read', 'registration.route_after', 'registration.profile_recheck',
  'card.resolve_number', 'card.resolve_cids', 'inventory.update', 'inventory.snapshot', 'inventory.publish',
  'writer.prepare', 'writer.maintenance', 'writer.executing', 'writer.commit', 'writer.receipt', 'writer.complete', 'writer.receipt_final',
  'journal.history_lookup', 'journal.read', 'journal.cas', 'journal.route', 'record.get', 'record.observe', 'record.decode', 'record.transaction',
  'inventory.native_read', 'inventory.receipt_lookup', 'inventory.stage_blobs', 'inventory.head_cas',
  'inventory.sync_head', 'inventory.sync_full', 'inventory.sync_unchanged',
  'login.binding', 'login.account_role', 'login.profile', 'login.inventory', 'login.claims', 'login.response',
  'claims.route_before', 'claims.lock_before', 'claims.source', 'claims.account',
  'claims.source_after', 'claims.lock_after', 'claims.settled', 'claims.route_after',
  'claims.acquire', 'claims.patch', 'claims.readback', 'claims.finish', 'claims.after_write',
  'membership.guard', 'membership.runtime', 'membership.prepare', 'membership.context', 'membership.start', 'membership.consume', 'membership.complete',
  'membership.verification', 'membership.account', 'membership.claims', 'membership.lease_begin', 'membership.lease_wait', 'membership.lease_end',
  'membership.storage_observe', 'membership.storage_transaction', 'membership.storage_callback',
  'membership.storage_encode', 'membership.storage_snapshot', 'membership.storage_context',
  'discord.provider', 'discord.token', 'discord.user', 'discord.member',
  'youtube.channel', 'youtube.csv', 'csv.pin',
]);
const round = value => Math.round(Math.max(0, value) * 1000) / 1000;
let firstRequest = true;

// 이름은 고정 목록만 사용한다. 인수·반환값·오류·사용자/작업 ID·DB 경로는 수집하지 않는다.
function measure(name, work) {
  const active = context.getStore();
  if (!active) return require('./membershipWorkerTiming').measure(name, work);
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

// 현재 검증 요청의 transaction span에만 숫자를 붙인다. ID·경로·원문·임의 필드는 받지 않는다.
const storageMetricFields = new Set([
  'inputParentJsonBytes', 'inputMembershipReceiptCount', 'inputProfileReceiptCount',
  'committedParentJsonBytes', 'committedMembershipReceiptCount', 'committedProfileReceiptCount',
  'callbackCount', 'processCpuUserMs', 'processCpuSystemMs',
  'inputMetricsMs', 'inputMetricsCpuMs', 'committedMetricsMs', 'committedMetricsCpuMs', 'metricsErrors',
]);
function captureMembershipStorageMetrics() {
  const active = context.getStore(), request = active?.request;
  if (!request || request.finished || !request.membershipStorageMetrics) return undefined;
  const span = request.spans[active.parent - 1];
  if (span?.name !== 'membership.storage_transaction') return undefined;
  const record = values => {
    if (request.finished) return;
    try {
      for (const key of storageMetricFields) {
        const descriptor = Object.getOwnPropertyDescriptor(values, key), value = descriptor?.value;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) continue;
        span.numbers ||= {}; span.numbers[key] = round(value);
      }
    } catch (_) { /* 계측 실패는 저장·응답·복구에 전파하지 않는다. */ }
  };
  record.isActive = () => !request.finished;
  return record;
}

function withInventoryRequestTiming(operation, handler, { emit = line => console.log(line) } = {}) {
  if (!['addCards', 'discardCards', 'moveCards'].includes(operation)) throw new Error('Invalid timing operation');
  return withRequestTiming(operation, handler, { emit, login: false });
}

function withLoginRequestTiming(operation, handler, { emit = line => console.log(line) } = {}) {
  if (!['getRegistrationStatus', 'getUserData'].includes(operation)) throw new Error('Invalid timing operation');
  return withRequestTiming(operation, handler, { emit, login: true });
}

const firstLoginRequests = new Set();
const firstMembershipRequests = new Set();
const firstPreparations = new Set();
function withMembershipRequestTiming(operation, handler, { emit = line => console.log(line) } = {}) {
  if (!['startDiscordMembershipVerification', 'verifyDiscordMembership', 'startYoutubeMembershipVerification', 'verifyYoutubeMembership'].includes(operation)) throw new Error('Invalid timing operation');
  return withRequestTiming(operation, handler, { emit, login: false, membership: true });
}
function withRequestTiming(operation, handler, { emit, login, membership = false }) {
  return (req, res) => {
    const preparation = req.body?.membershipPrepare === true;
    if (login ? !['GET', 'POST'].includes(req.method) || !preparation && (req.query?.warmup === 'true' || req.body?.warmup === 'true')
      : req.method !== 'POST') return handler(req, res);
    const request = { started: performance.now(), spans: [], dropped: 0, finished: false,
      membershipStorageMetrics: membership && !preparation && ['verifyDiscordMembership', 'verifyYoutubeMembership'].includes(operation) };
    let readDiagnostics;
    if (login && operation === 'getUserData') {
      try { readDiagnostics = require('./rtdbReadDiagnostics').createReadDiagnostics(request.started); } catch (_) { /* 관측 실패 격리 */ }
    }
    const requestId = randomBytes(12).toString('hex');
    const first = preparation ? !firstPreparations.has(operation)
      : membership ? !firstMembershipRequests.has(operation) : login ? !firstLoginRequests.has(operation) : firstRequest;
    if (preparation) firstPreparations.add(operation);
    else if (membership) firstMembershipRequests.add(operation);
    else if (login) firstLoginRequests.add(operation); else firstRequest = false;
    const processAgeMs = round(uptime() * 1000);
    if (login) {
      try {
        // 요청 입력을 상관 ID로 사용하지 않으며 헤더 추가 실패도 업무를 막지 않는다.
        res.setHeader('X-YGO-Login-Timing', requestId);
        const exposed = res.getHeader('Access-Control-Expose-Headers');
        res.setHeader('Access-Control-Expose-Headers', [exposed, 'X-YGO-Login-Timing'].filter(Boolean).join(', '));
      } catch (_) { /* 합성 응답/이미 시작된 응답도 기존 처리를 유지한다. */ }
    }
    function finish(completed) {
      if (request.finished) return;
      request.finished = true;
      let rtdbReads;
      try { rtdbReads = readDiagnostics?.finish(); } catch (_) { /* 관측 종료 오류도 응답에 전파하지 않는다. */ }
      // 계측 출력 실패가 성공 응답이나 복구 경계를 바꾸지 않는다.
      try { emit(JSON.stringify({ severity: 'INFO', event: membership ? 'membership_request_timing' : login ? 'login_request_timing' : 'inventory_request_timing', version: 1,
        operation, requestId, firstTimedRequest: first, processAgeMs, ...(preparation ? { preparation: true } : {}),
        status: Number.isInteger(res.statusCode) ? res.statusCode : 0, completed,
        totalMs: round(performance.now() - request.started), droppedSpans: request.dropped,
        ...(rtdbReads ? { rtdbReads } : {}),
        spans: request.spans.map(span => ({ ...span })) })); } catch (_) { /* 관측 실패를 업무에 전파하지 않는다. */ }
    }
    const observable = typeof res.once === 'function';
    if (observable) { res.once('finish', () => finish(true)); res.once('close', () => finish(false)); }
    const run = () => context.run({ request, parent: 0 }, async () => {
      try { return await handler(req, res); }
      finally { if (!observable) finish(true); }
    });
    return readDiagnostics ? readDiagnostics.run(run) : run();
  };
}

module.exports = { measure, withInventoryRequestTiming, withLoginRequestTiming, withMembershipRequestTiming, captureMembershipStorageMetrics, MAX_SPANS };
