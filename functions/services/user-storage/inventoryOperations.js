'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { encodeKey } = require('./codec');
const { cardBlobPath } = require('./inventoryManifest');
const { createStorageAccess, validateStoragePath } = require('./storageAccess');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = (code, message) => Object.assign(new Error(message), { code });
const invalid = () => { throw fail('USER_STORAGE_INVALID_OPERATION', '인벤토리 작업 기록이 올바르지 않습니다. 원본을 보존합니다.'); };
const token = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const digestOf = plan => createHash('sha256').update(JSON.stringify(plan)).digest('hex');
const terminal = state => state === 'committed' || state === 'cancelled';
function fields(value, required, optional = []) {
  if (!plain(value) || required.some(key => !own(value, key))
      || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}

// 작업 계획에는 주소/버전만 남긴다. 카드 본문이나 요청/응답 원문은 복제하지 않는다.
function createInventoryOperations({ database, path = 'inventoryOperations', partsPath = 'inventoryCardVersions', timeoutMs, onAmbiguousWrite } = {}) {
  path = validateStoragePath(path);
  const access = createStorageAccess({ database, timeoutMs, onAmbiguousWrite });
  const target = (uid, id) => {
    if (!token(id)) invalid();
    return validateStoragePath(`${path}/${encodeKey(uid)}/${id}`);
  };
  function map(uid, value) {
    if (!plain(value) || !Object.keys(value).length) invalid();
    return Object.fromEntries(Object.keys(value).sort().map(hash => {
      if (!token(value[hash])) invalid();
      cardBlobPath(uid, hash, value[hash], { partsPath });
      return [hash, value[hash]];
    }));
  }
  function planFor(uid, value) {
    fields(value, ['expectedRevision', 'generation', 'kind'], ['staged', 'retired']);
    if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0
        || !Number.isSafeInteger(value.generation) || value.generation < 0 || value.generation > value.expectedRevision
        || !['update', 'clear'].includes(value.kind)) invalid();
    const plan = { expectedRevision: value.expectedRevision, generation: value.generation, kind: value.kind };
    for (const name of ['staged', 'retired']) if (own(value, name)) plan[name] = map(uid, value[name]);
    if (plan.kind === 'clear' && plan.staged) invalid();
    for (const [hash, version] of Object.entries(plan.staged || {})) if (plan.retired?.[hash] === version) invalid();
    return plan;
  }
  function parse(uid, id, raw) {
    if (raw === null || raw === undefined) throw fail('USER_STORAGE_OPERATION_NOT_FOUND', '저장 작업 기록을 찾을 수 없습니다. 자동 복구하지 않습니다.');
    fields(raw, ['version', 'plan', 'digest', 'state', 'ready', 'cleanup'], ['receipt']);
    const plan = planFor(uid, raw.plan);
    if (raw.version !== 1 || raw.digest !== digestOf(plan) || typeof raw.ready !== 'boolean'
        || !['prepared', 'ready', 'committed', 'cancelled'].includes(raw.state)
        || !['pending', 'complete', 'fenced'].includes(raw.cleanup)
        || (raw.state === 'prepared' && raw.ready) || (raw.state === 'ready' && !raw.ready)
        || (raw.state === 'committed' && !raw.ready)
        || (!terminal(raw.state) && (raw.cleanup !== 'pending' || own(raw, 'receipt')))
        || (terminal(raw.state) && !own(raw, 'receipt'))
        || (raw.cleanup === 'fenced' && (raw.state !== 'cancelled' || raw.ready || !plan.staged))
        || (raw.cleanup === 'complete' && raw.state === 'cancelled' && !raw.ready && plan.staged)) invalid();
    if (own(raw, 'receipt')) {
      fields(raw.receipt, ['id', 'digest', 'outcome', 'revision', 'generation']);
      const r = raw.receipt;
      if (r.id !== id || r.digest !== raw.digest || r.outcome !== raw.state
          || !Number.isSafeInteger(r.revision) || r.revision <= plan.expectedRevision
          || !Number.isSafeInteger(r.generation) || r.generation < plan.generation || r.generation > r.revision
          || (r.outcome === 'committed' && (r.revision !== plan.expectedRevision + 1
            || r.generation !== plan.generation + (plan.kind === 'clear' ? 1 : 0)))) invalid();
    }
    return { ...raw, plan };
  }
  async function transact(uid, id, change) {
    access.ensureUsable();
    const ref = database.ref(target(uid, id));
    let onValue, callbackError, listenerError;
    try {
      await access.guarded(new Promise((resolve, reject) => {
        onValue = resolve;
        ref.on('value', onValue, error => { listenerError = error; reject(error); });
      }));
      // 저널 전이는 멱등적이며 업무 저장 성공을 뒤집지 않는다. 시간초과여도
      // 서버에서 늦게 완료될 수 있으므로 다음 대조는 반드시 최신 저널을 읽는다.
      const result = await access.guarded(ref.transaction(raw => {
        if (listenerError) return undefined;
        try { return change(raw === null ? null : parse(uid, id, raw)); }
        catch (error) { callbackError = error; return undefined; }
      }, undefined, false));
      if (callbackError) throw callbackError;
      if (listenerError) throw listenerError;
      if (!result.committed) throw fail('USER_STORAGE_OPERATION_CANCELLED', '이 저장 시도는 취소되어 다시 제출할 수 없습니다.');
      return parse(uid, id, result.snapshot.val());
    } finally { if (onValue) ref.off('value', onValue); }
  }
  const api = {
    newId: () => randomUUID().replace(/-/g, ''),
    async read(uid, id) { return parse(uid, id, await access.read(target(uid, id))); },
    confirmed(uid, id, operation, receipt) {
      if (terminal(operation.state) && (operation.state !== receipt.outcome
          || Object.keys(operation.receipt).some(key => operation.receipt[key] !== receipt[key]))) invalid();
      return parse(uid, id, { ...operation, state: receipt.outcome, receipt });
    },
    async create(uid, id, input) {
      const plan = planFor(uid, input), digest = digestOf(plan);
      return transact(uid, id, raw => {
        if (raw) invalid(); // ID를 재사용해 다른 요청을 덮거나 재실행하지 않는다.
        return { version: 1, plan, digest, state: 'prepared', ready: false, cleanup: 'pending' };
      });
    },
    async ready(uid, id) {
      return transact(uid, id, raw => {
        if (!raw) invalid();
        if (terminal(raw.state)) return undefined;
        return { ...raw, state: 'ready', ready: true };
      });
    },
    async archive(uid, receipt) {
      return transact(uid, receipt.id, raw => {
        if (!raw || raw.digest !== receipt.digest) invalid();
        if (terminal(raw.state)) {
          if (raw.state !== receipt.outcome || JSON.stringify(raw.receipt) !== JSON.stringify(receipt)) {
            // RTDB는 객체 키 순서를 보존하지 않으므로 필드값으로 비교한다.
            if (raw.state !== receipt.outcome || Object.keys(receipt).some(key => raw.receipt?.[key] !== receipt[key])) invalid();
          }
          return raw;
        }
        const next = { ...raw, state: receipt.outcome, receipt };
        parse(uid, receipt.id, next);
        return next;
      });
    },
    async finish(uid, id, cleanup) {
      return transact(uid, id, raw => {
        if (!raw || !terminal(raw.state) || !['complete', 'fenced'].includes(cleanup)) invalid();
        if (raw.cleanup !== 'pending' && raw.cleanup !== cleanup) invalid();
        const next = { ...raw, cleanup };
        parse(uid, id, next);
        return next;
      });
    },
    paths(uid, operation, name) {
      return Object.entries(operation.plan[name] || {}).map(([hash, version]) => ({
        hash, token: version, path: cardBlobPath(uid, hash, version, { partsPath }),
      }));
    },
    async stage(entry) {
      access.ensureUsable();
      const result = await access.guarded(database.ref(validateStoragePath(entry.path))
        .transaction(raw => raw === null ? entry.value : undefined, undefined, false), true);
      if (!result.committed) throw fail('USER_STORAGE_OPERATION_CANCELLED', '폐쇄되었거나 이미 사용된 카드 버전 주소입니다.');
    },
    async closeStage(entry, operationId) {
      // 취소가 head CAS로 확정된 계획의 주소만 허용한다. 이 작은 표식은 늦은
      // create-only stage를 막으므로 시간 기준으로 지우거나 새 버전에 재사용하지 않는다.
      access.ensureUsable();
      await access.guarded(database.ref(validateStoragePath(entry.path)).transaction(() =>
        ({ type: 'inventory-stage-closed', version: 1, operationId }), undefined, false));
    },
  };
  return api;
}

module.exports = { createInventoryOperations };
