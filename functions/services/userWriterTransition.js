'use strict';
const { measure } = require('./inventoryRequestTiming');
const { randomBytes } = require('node:crypto');
const { encodeKey, encodeValue, decodeValue } = require('./user-storage/codec');
const { fingerprint, content } = require('./userMigrationRehearsal');
const { validateState, requirements } = require('./user-storage/writerState');
const { checkProjection } = require('./user-storage/writerJournalStore');
const fail = code => Object.assign(new Error('사용자 writer의 전환 상태와 저장 영수증을 대조해야 합니다.'), { code });
const { cloneStoredValue: clone } = require('./user-storage/cloneStoredValue');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const idCheck = id => { if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw fail('WRITER_INVALID_ID'); };
const other = backend => backend === 'legacy' ? 'rtdb' : 'legacy';
const recordMap = entries => new Map(entries.map(entry => [entry.key, entry]));
const absent = key => ({ key, exists: false, token: '0' });

// 명시적으로 주입된 저장소만 사용한다. 기존 HTTP·CLI·기본 앱의 writer를 자동 전환하지 않는다.
function createUserWriterTransition({ journal, history, plans, runId, stores, checkKey, checkCommand = () => {},
  maxOperations = 128, maxBytes = 4 * 1024 * 1024, historyMaintenance = 'inline',
  receiptMatches = (_op, actual, planned) => content(actual) === content(planned),
  reserveChange = (_op, entry) => entry, onCheckpoint = async () => {} } = {}) {
  idCheck(runId);
  if (!journal?.read || !journal?.update || !stores?.legacy || !stores?.rtdb || typeof checkKey !== 'function'
      || typeof receiptMatches !== 'function' || typeof reserveChange !== 'function'
      || !['inline', 'deferred'].includes(historyMaintenance) || historyMaintenance === 'deferred' && !history
      || !Number.isSafeInteger(maxOperations) || maxOperations < 1 || maxOperations > 1024
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 8 * 1024 * 1024
      || history && (typeof history.get !== 'function' || typeof history.put !== 'function')
      || plans && !['save', 'scan', 'expected', 'checkpoint', 'sealExpected', 'verify', 'digest'].every(key => typeof plans[key] === 'function')) throw fail('WRITER_INVALID_DEPENDENCIES');
  for (const store of Object.values(stores)) {
    if (!['snapshot', 'commit', 'receipt', 'apply'].every(method => typeof store[method] === 'function')) throw fail('WRITER_INVALID_DEPENDENCIES');
  }
  function entriesCheck(entries, command = false) {
    if (!Array.isArray(entries) || !entries.length && command) throw fail('WRITER_INVALID_RECORDS');
    const keys = new Set();
    for (const entry of entries) {
      if (!entry || typeof entry.key !== 'string' || keys.has(entry.key) || typeof entry.exists !== 'boolean'
          || typeof entry.token !== 'string' || !entry.token || entry.token.length > 128
          || Object.keys(entry).some(key => !['key', 'exists', 'token', 'value'].includes(key)) || entry.exists && !own(entry, 'value')
          || !entry.exists && own(entry, 'value')) throw fail('WRITER_INVALID_RECORDS');
      checkKey(entry.key); keys.add(entry.key); encodeValue(entry);
    }
    return entries;
  }
  function valid(state) {
    const needed = requirements(state);
    if (!plans && needed.requiresPlans) throw fail('WRITER_PLAN_STORE_REQUIRED');
    if (!history && needed.requiresHistory) throw fail('WRITER_HISTORY_REQUIRED');
    if (state?.planMaintenance !== undefined) {
      const hold = state.planMaintenance;
      if (typeof plans?.cleanup?.candidates !== 'function') throw fail('WRITER_PLAN_STORE_REQUIRED');
      if (!hold || Object.keys(hold).sort().join(',') !== 'backend,epoch,id,previousPhase' || state.phase !== 'draining'
          || hold.backend !== state.backend || hold.epoch !== state.epoch || !['accepting', 'draining'].includes(hold.previousPhase)) throw fail('WRITER_STATE_INVALID');
      idCheck(hold.id);
    }
    if (state?.transfer?.collectionMode !== undefined && (state.transfer.collectionMode !== 'paged'
        || state.transfer.planMode !== 'partitioned' || typeof plans?.collect !== 'function'
        || !Object.values(stores).every(store => typeof store.snapshotPage === 'function'))) throw fail('WRITER_PLAN_STORE_REQUIRED');
    if (state?.lastResume !== undefined) {
      const resume = state.lastResume;
      if (!resume || Object.keys(resume).sort().join(',') !== 'backend,fromEpoch,id,toEpoch'
          || !['legacy', 'rtdb'].includes(resume.backend) || !Number.isSafeInteger(resume.fromEpoch) || resume.fromEpoch < 1
          || !Number.isSafeInteger(resume.toEpoch) || resume.toEpoch !== resume.fromEpoch + 1 || resume.toEpoch > state.epoch) throw fail('WRITER_STATE_INVALID');
      idCheck(resume.id);
    }
    return validateState(state);
  }
  async function read() { const record = await journal.read(runId); return record.exists ? valid(record.value) : undefined; }
  const historyVersion = state => state?.historyVersion || 0;
  // 보관 조회와 hot CAS 사이에 정리가 일어나면 다시 조회한다. 완료 ID를 새 명령으로 재등록하지 않는다.
  async function historyGuard(kind, id, action) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const state = await read(), value = state?.[kind]?.[id] || await history?.get(kind, id);
      try { return await action(value, historyVersion(state)); }
      catch (error) {
        if (error.code === 'WRITER_JOURNAL_FULL' && history) {
          try { const progress = await compact({ limit: 128 }); if (progress.moved || progress.removedEvents) continue; }
          catch (compactionError) { if (compactionError.code === 'WRITER_HISTORY_CHANGED') continue; throw compactionError; }
        }
        if (error.code !== 'WRITER_HISTORY_CHANGED') throw error;
      }
    }
    throw fail('WRITER_HISTORY_CHANGED');
  }
  function sameHistory(state, version) { if (historyVersion(state) !== version) throw fail('WRITER_HISTORY_CHANGED'); }
  async function operationFor(id) { const state = await read(); return state?.operations[id] || await history?.get('operations', id); }
  function capacity(next) {
    // 업무 RPC 전에 receipt+변경 기록의 공간도 예약한다. 포착만 나중에 용량 초과로 막지 않는다.
    // 용량 계산은 codec의 읽기 전용 순회다. 바꾸지 않는 완료 본문은 복제하지 않고,
    // 예약 상태를 합성할 미완료 명령만 소유 사본으로 만든다. 상한 계산식은 동일하다.
    const reserved = { ...next, operations: { ...next.operations }, events: [...next.events] };
    for (const [id, original] of Object.entries(reserved.operations)) {
      if (!['prepared', 'executing'].includes(original.status)) continue;
      const op = clone(original); reserved.operations[id] = op;
      const changes = op.changes.map(entry => ({ ...reserveChange(op, clone(entry)), token: '9'.repeat(128) }));
      op.status = 'completed'; op.execution = 'f'.repeat(32);
      op.capturedSequence = Number.MAX_SAFE_INTEGER;
      op.receipt = { id: op.id, digest: op.digest, changes, result: clone(op.result) };
      reserved.events.push({ sequence: Number.MAX_SAFE_INTEGER, epoch: op.epoch, operationId: op.id, changes });
    }
    if (Buffer.byteLength(JSON.stringify(encodeValue(reserved))) > maxBytes) throw fail('WRITER_JOURNAL_FULL');
  }
  async function change(mutate) {
    const result = await journal.update(runId, value => {
      const next = mutate(value === undefined ? undefined : clone(valid(value)));
      capacity(next);
      return { value: next };
    });
    return valid(result.record.value);
  }
  function matches(state, writer, accepting = false) {
    if (!state || !writer || state.backend !== writer.backend || state.epoch !== writer.epoch) throw fail('WRITER_FENCED');
    if (state.planMaintenance) throw fail('WRITER_PLAN_MAINTENANCE');
    if (accepting && state.phase !== 'accepting') throw fail('WRITER_DRAINING');
  }
  const externalPending = state => Object.values(state.external || {}).filter(op => ['running', 'uncertain'].includes(op.status));
  function unresolved(state) { return Object.values(state.operations).some(op => ['prepared', 'executing'].includes(op.status)) || externalPending(state).length > 0; }
  function externalSettled(state, op, seen = new Set()) {
    if (op?.status === 'completed') return true;
    if (op?.status !== 'recovered' || seen.has(op.id)) return false;
    seen.add(op.id); return externalSettled(state, state.external?.[op.recoveryId], seen);
  }
  async function compact({ limit = 32 } = {}) {
    if (!history) throw fail('WRITER_HISTORY_REQUIRED');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw fail('WRITER_INVALID_RECORDS');
    const initial = await read(); if (!initial) throw fail('WRITER_NOT_INITIALIZED');
    const operations = Object.values(initial.operations).filter(op => ['completed', 'cancelled'].includes(op.status)).slice(0, limit);
    // 복구 체인은 전체가 종료됐을 때만 함께 보관한다. 중간 recovered 표식은 잠금 증거다.
    const external = Object.values(initial.external || {}).filter(op => externalSettled(initial, op));
    const incoming = new Set(external.map(op => op.recoveryId).filter(Boolean)), chosen = [];
    for (const root of external.filter(op => !incoming.has(op.id))) {
      const group = [root]; let next = root;
      while (next.recoveryId) { next = initial.external[next.recoveryId]; group.push(next); }
      if (group.length <= limit - operations.length - chosen.length) chosen.push(...group);
    }
    const candidates = [...operations.map(value => ['operations', value]), ...chosen.map(value => ['external', value])];
    const archived = new Map();
    const prepared = candidates.map(([kind, value]) => {
      const saved = clone(value);
      if (kind === 'operations' && saved.status === 'completed') {
        saved.capturedSequence ??= initial.events.find(event => event.operationId === value.id)?.sequence;
        if (!Number.isSafeInteger(saved.capturedSequence) || saved.capturedSequence < 1) throw fail('WRITER_HISTORY_CONFLICT');
      }
      return { kind, saved };
    });
    // 서로 다른 불변 주소만 제한 병렬로 보관한다. 실패해도 이미 시작한 요청의
    // 종료를 기다리고 hot은 유지한다. 전체 보관 대조가 끝나야 아래 CAS로 제거한다.
    let next = 0, failed = false;
    const results = [];
    const archive = () => Promise.all(Array.from({ length: Math.min(journal.withSession ? 4 : 1, prepared.length) }, async () => {
      while (!failed && next < prepared.length) {
        const index = next++, { kind, saved } = prepared[index];
        try {
          await history.put(kind, saved.id, saved);
          if (kind === 'operations') archived.set(saved.id, saved);
          await onCheckpoint('historyArchived', { kind, id: saved.id });
        } catch (error) { results[index] = error; failed = true; }
      }
    }));
    // 공유 범위는 불변 본문 생성뿐이다. 각 envelope 공개 후 DB 재대조는 생략하지 않는다.
    if (history.withSession) await history.withSession(archive); else await archive();
    const error = results.find(Boolean); if (failed) throw error;
    const initialThrough = initial.transfer ? initial.transfer.cursor : initial.sequence;
    const removable = new Set();
    for (const event of initial.events) {
      if (event.sequence > initialThrough) continue;
      let op = archived.get(event.operationId);
      if (!op && event.receiptDigest) op = await history.get('operations', event.operationId);
      if (!op) continue;
      if (op.status !== 'completed' || op.capturedSequence !== event.sequence || op.epoch !== event.epoch
          || event.receiptDigest && fingerprint(op.receipt) !== event.receiptDigest) throw fail('WRITER_HISTORY_CONFLICT');
      removable.add(event.sequence);
    }
    // 주기 작업의 유휴 실행은 journal revision을 올리거나 writer와 경합하지 않는다.
    if (!candidates.length && !removable.size) return { moved: 0, removedEvents: 0, ...await historyStatus() };
    let moved = 0, removedEvents = 0;
    await change(state => {
      sameHistory(state, historyVersion(initial));
      for (const [kind, value] of candidates) {
        if (fingerprint(state[kind]?.[value.id]) !== fingerprint(value)) throw fail('WRITER_HISTORY_CONFLICT');
        if (kind === 'external' && !externalSettled(state, value)) throw fail('WRITER_HISTORY_CONFLICT');
      }
      const through = Math.min(initialThrough, state.transfer ? state.transfer.cursor : state.sequence);
      const canRemove = event => event.sequence <= through && removable.has(event.sequence);
      removedEvents = state.events.filter(canRemove).length;
      state.events = state.events.filter(event => !canRemove(event)).map(event => {
        const op = archived.get(event.operationId);
        return op ? { sequence: event.sequence, epoch: event.epoch, operationId: event.operationId, receiptDigest: fingerprint(op.receipt) } : event;
      });
      if (!state.transfer) state.floor = Math.max(state.floor, through);
      else for (const marker of Object.keys(state.transfer.applied)) {
        const match = /^event:(\d+):\d+$/.exec(marker);
        if (match && Number(match[1]) <= through) delete state.transfer.applied[marker];
      }
      for (const [kind, value] of candidates) delete state[kind][value.id];
      moved = candidates.length;
      if (moved || removedEvents) {
        if (historyVersion(state) === Number.MAX_SAFE_INTEGER) throw fail('WRITER_SEQUENCE_EXHAUSTED');
        state.historyVersion = historyVersion(state) + 1;
        state.historyCounts ||= { operations: 0, external: 0 };
        if (!Number.isSafeInteger(state.historyCounts.operations + operations.length)
            || !Number.isSafeInteger(state.historyCounts.external + chosen.length)) throw fail('WRITER_SEQUENCE_EXHAUSTED');
        state.historyCounts.operations += operations.length; state.historyCounts.external += chosen.length;
      }
      return state;
    });
    return { moved, removedEvents, ...await historyStatus() };
  }
  async function maintain() {
    // hot journal 자체가 영구 대기 목록이다. 완료 포착/업무 receipt와 용량 예약은
    // 동기 유지하고, hard 상한의 historyGuard 정리·실패 경로도 그대로 둔다.
    if (historyMaintenance === 'deferred') return;
    if (!history) return;
    const state = await read(); if (!state) return;
    const count = Object.keys(state.operations).length + Object.keys(state.external || {}).length;
    // native journal은 큰 완료 본문이 수십 요청 동안 hot CAS에 남지 않게 한다.
    // 불변 보관/영수증 승인 뒤의 기존 compact만 사용하며 hard 상한은 바꾸지 않는다.
    const hotTarget = journal.withSession ? Math.min(maxBytes / 2, 64 * 1024) : maxBytes / 2;
    const hotBytes = Buffer.byteLength(JSON.stringify(encodeValue(state)));
    const settled = Object.values(state.operations).filter(op => ['completed', 'cancelled'].includes(op.status)).length
      + Object.values(state.external || {}).filter(op => externalSettled(state, op)).length;
    // 작은 완료 기록은4건씩 모은다. 카드 수가 많아 한 명령만64KiB를 넘더라도
    // 매 수정마다 보관하지 않으며, 큰 본문/건수·hard 용량 경계는 계속 보호한다.
    const batchReady = !journal.withSession || settled >= 4 || hotBytes >= Math.min(maxBytes / 2, 512 * 1024);
    if (count >= Math.max(1, Math.floor(maxOperations / 2)) || hotBytes >= hotTarget && batchReady) {
      try {
        const progress = await compact({ limit: journal.withSession ? 4 : 32 });
        if (!progress.moved && Object.values(state.external || {}).some(op => externalSettled(state, op))) await compact({ limit: 128 });
      } catch (error) { if (error.code !== 'WRITER_HISTORY_CHANGED') throw error; }
    }
  }
  async function historyStatus() {
    const state = await read(); if (!state) throw fail('WRITER_NOT_INITIALIZED');
    return { enabled: !!history, version: historyVersion(state), archived: clone(state.historyCounts || { operations: 0, external: 0 }),
      retainedOperations: Object.keys(state.operations).length, retainedExternal: Object.keys(state.external || {}).length,
      retainedEvents: state.events.length, hotBytes: Buffer.byteLength(JSON.stringify(encodeValue(state))), maxOperations, maxBytes };
  }
  async function initialize() {
    await change(state => state || { format: 1, backend: 'legacy', epoch: 1, phase: 'accepting', sequence: 0,
      floor: 0, operations: {}, events: [], transfer: null, frozen: {} });
    return route();
  }
  async function route() {
    if (typeof journal.readRoute === 'function') {
      const record = await journal.readRoute(runId); if (!record.exists) throw fail('WRITER_NOT_INITIALIZED');
      checkProjection(record.value);
      if (record.value.key !== encodeKey(runId) || record.value.revision !== record.revision) throw fail('WRITER_STATE_INVALID');
      if (record.value.requiresPlans && !plans) throw fail('WRITER_PLAN_STORE_REQUIRED');
      if (record.value.requiresHistory && !history) throw fail('WRITER_HISTORY_REQUIRED');
      return { backend: record.value.backend, epoch: record.value.epoch, phase: record.value.phase };
    }
    const state = await read(); if (!state) throw fail('WRITER_NOT_INITIALIZED');
    return { backend: state.backend, epoch: state.epoch, phase: state.phase };
  }
  async function prepareOperation(writer, id, changes, result = null, { resources = [], details, parentExternal } = {}, execution) {
    idCheck(id); entriesCheck(changes, true); encodeValue(result); checkCommand(writer?.backend, changes, details);
    if (!Array.isArray(resources)) throw fail('WRITER_INVALID_RECORDS');
    const locks = [...new Set([...changes.map(entry => entry.key), ...resources])].sort();
    for (const key of locks) checkKey(key);
    if (details !== undefined) encodeValue(details);
    const digest = fingerprint({ writer: { backend: writer?.backend, epoch: writer?.epoch }, changes, result, resources: locks,
      ...(details !== undefined ? { details } : {}), ...(parentExternal ? { parentExternal } : {}) });
    await measure('writer.maintenance', maintain);
    return historyGuard('operations', id, async (known, version) => {
    if (known && ['completed', 'cancelled'].includes(known.status)) {
      if (known.digest !== digest) throw fail('WRITER_OPERATION_CONFLICT'); return clone(known);
    }
    const state = await change(state => {
      sameHistory(state, version);
      if (state?.operations[id]) {
        if (state.operations[id].digest !== digest) throw fail('WRITER_OPERATION_CONFLICT');
        return state;
      }
      const parent = parentExternal && state?.external?.[parentExternal];
      if (parentExternal && (!parent || parent.status !== 'running' || parent.backend !== writer?.backend || parent.epoch !== writer?.epoch || locks.some(key => !parent.resources.includes(key)))) throw fail('WRITER_FENCED');
      matches(state, writer, !parent);
      if (Object.keys(state.operations).length + Object.keys(state.external || {}).length >= maxOperations) throw fail('WRITER_JOURNAL_FULL');
      // 미확정 작업의 자원을 재사용하지 않는다. 여러 키를 한 업무 transaction으로 묶을 수 있다.
      const locked = new Set([...Object.values(state.operations).filter(op => ['prepared', 'executing'].includes(op.status)), ...externalPending(state).filter(op => op.id !== parentExternal)].flatMap(op => op.resources));
      if (locks.some(key => locked.has(key))) throw fail('WRITER_RESOURCE_BUSY');
      state.operations[id] = { id, digest, backend: writer.backend, epoch: writer.epoch,
        status: execution ? 'executing' : 'prepared', ...(execution ? { execution } : {}), resources: locks, changes: clone(changes), result: clone(result),
        ...(details !== undefined ? { details: clone(details) } : {}) };
      return state;
    });
    return clone(state.operations[id]);
    });
  }
  const prepare = (writer, id, changes, result, options) => prepareOperation(writer, id, changes, result, options);
  function validateCommittedReceipt(operation, receipt) {
    if (!receipt || Object.keys(receipt).some(key => !['id', 'digest', 'changes', 'result'].includes(key))
        || receipt.id !== operation.id || receipt.digest !== operation.digest) throw fail('WRITER_RECEIPT_REQUIRED');
    entriesCheck(receipt.changes, true);
    if (fingerprint(receipt.result) !== fingerprint(operation.result)
        || receipt.changes.length !== operation.changes.length
        || receipt.changes.some(entry => !operation.changes.some(planned => planned.key === entry.key
          && receiptMatches(operation, entry, planned) === true))) throw fail('WRITER_RECEIPT_CONFLICT');
  }
  function executionResult(operation, receipt, result, withReceipt, receiptVerified = false) {
    if (!withReceipt) return clone(result);
    if (!receiptVerified) validateCommittedReceipt(operation, receipt);
    return { result: clone(result), receipt: clone(receipt) };
  }
  async function complete(operation, receipt) {
    if (receipt?.outcome === 'cancelled') {
      if (receipt.id !== operation.id || receipt.digest !== operation.digest
          || Object.keys(receipt).length !== 3) throw fail('WRITER_RECEIPT_CONFLICT');
      await historyGuard('operations', operation.id, async (known, version) => {
      if (known && known.digest !== operation.digest) throw fail('WRITER_OPERATION_CONFLICT');
      if (known?.status === 'cancelled') return;
      await change(state => {
        sameHistory(state, version);
        const op = state.operations[operation.id];
        if (!op || op.digest !== operation.digest) throw fail('WRITER_OPERATION_CONFLICT');
        if (op.status === 'cancelled') return state;
        if (op.status !== 'executing') throw fail('WRITER_RECEIPT_CONFLICT');
        matches(state, op); op.status = 'cancelled'; op.receipt = clone(receipt); return state;
      });
      });
      throw fail('WRITER_CANCELLED');
    }
    validateCommittedReceipt(operation, receipt);
    await historyGuard('operations', operation.id, async (known, version) => {
    if (known && known.digest !== operation.digest) throw fail('WRITER_OPERATION_CONFLICT');
    if (known?.status === 'completed') {
      if (fingerprint(known.receipt) !== fingerprint(receipt)) throw fail('WRITER_RECEIPT_CONFLICT'); return;
    }
    await change(state => {
      sameHistory(state, version);
      const op = state.operations[operation.id];
      if (!op || op.digest !== operation.digest) throw fail('WRITER_OPERATION_CONFLICT');
      if (op.status === 'completed') {
        if (fingerprint(op.receipt) !== fingerprint(receipt)) throw fail('WRITER_RECEIPT_CONFLICT');
        return state;
      }
      if (op.status !== 'executing') throw fail('WRITER_OPERATION_CONFLICT');
      matches(state, op);
      if (state.sequence === Number.MAX_SAFE_INTEGER) throw fail('WRITER_SEQUENCE_EXHAUSTED');
      state.sequence++;
      op.status = 'completed'; op.receipt = clone(receipt); op.capturedSequence = state.sequence;
      state.events.push({ sequence: state.sequence, epoch: op.epoch, operationId: op.id, changes: clone(receipt.changes) });
      return state;
    });
    });
    await onCheckpoint('captured', operation.id);
    return clone(operation.result);
  }
  async function execute(writer, id, withReceipt = false) {
    idCheck(id); const execution = randomBytes(16).toString('hex');
    const known = await operationFor(id);
    if (!known || known.backend !== writer?.backend || known.epoch !== writer?.epoch) throw fail('WRITER_OPERATION_CONFLICT');
    if (known.status === 'completed') return executionResult(known, known.receipt, known.result, withReceipt);
    if (known.status === 'cancelled') throw fail('WRITER_CANCELLED');
    const state = await measure('writer.executing', () => change(state => {
      const op = state?.operations[id];
      if (!op || op.backend !== writer?.backend || op.epoch !== writer?.epoch) throw fail('WRITER_OPERATION_CONFLICT');
      if (op.status === 'completed') return state;
      if (op.status === 'cancelled') throw fail('WRITER_CANCELLED');
      matches(state, writer); // drain 뒤에도 이미 등록된 처리 한 번만 완료한다.
      if (op.status !== 'prepared') throw fail('WRITER_OUTCOME_UNRESOLVED');
      op.status = 'executing'; op.execution = execution; return state;
    }));
    const op = state.operations[id];
    if (op.status === 'completed') return executionResult(op, op.receipt, op.result, withReceipt);
    return commitExecution(op, id, withReceipt);
  }
  async function commitExecution(op, id, withReceipt) {
    // RPC 거부/시간초과도 자동 취소·재실행하지 않는다. 영구 영수증으로 복구한다.
    await onCheckpoint('executing', id);
    const adapter = stores[op.backend]; let confirmed;
    await measure('writer.commit', () => adapter.commit(clone(op), receipt => {
      confirmed = clone(receipt);
    }));
    await onCheckpoint('businessCommitted', id);
    // 새 CAS의 확정 증거만 재사용한다. 미확정/경합/복구는 fresh reader를 유지한다.
    const receipt = await measure('writer.receipt', () => confirmed === undefined ? adapter.receipt(clone(op)) : confirmed);
    const result = await measure('writer.complete', () => complete(op, receipt));
    return executionResult(op, receipt, result, withReceipt, true);
  }
  async function prepareAndExecuteWithReceipt(writer, id, changes, result = null, options = {}) {
    if (options.onPrepared !== undefined && typeof options.onPrepared !== 'function') throw fail('WRITER_INVALID_DEPENDENCIES');
    const execution = randomBytes(16).toString('hex');
    // 새 명령의 자원 잠금·용량 예약·실행 소유권을 같은 journal CAS로 확정한다.
    // ACK를 받기 전에는 업무 RPC를 시작하지 않는다. 재호출은 새 소유권으로
    // 기존 executing을 인계받을 수 없으며 기존 fresh recover/fence를 사용한다.
    const op = await measure('writer.prepare', () => prepareOperation(writer, id, changes, result, options, execution));
    options.onPrepared?.(clone(op));
    if (op.status === 'completed') return executionResult(op, op.receipt, op.result, true);
    if (op.status === 'cancelled') throw fail('WRITER_CANCELLED');
    if (op.status === 'prepared') return execute(writer, id, true);
    if (op.status !== 'executing' || op.execution !== execution) throw fail('WRITER_OUTCOME_UNRESOLVED');
    return commitExecution(op, id, true);
  }
  async function recover(id) {
    idCheck(id); const op = await operationFor(id);
    if (!op) throw fail('WRITER_OPERATION_CONFLICT');
    if (op.status === 'completed') return clone(op.result);
    if (op.status === 'cancelled') throw fail('WRITER_CANCELLED');
    if (op.status !== 'executing') throw fail('WRITER_OUTCOME_UNRESOLVED');
    const receipt = await measure('writer.receipt', () => stores[op.backend].receipt(clone(op)));
    return measure('writer.complete', () => complete(op, receipt));
  }
  async function fenceUncommitted(id) {
    idCheck(id); const op = await operationFor(id);
    if (!op) throw fail('WRITER_OPERATION_CONFLICT');
    if (op.status === 'completed' || op.status === 'cancelled') return { status: op.status };
    if (op.status !== 'executing') throw fail('WRITER_OUTCOME_UNRESOLVED');
    const adapter = stores[op.backend];
    // 같은 업무 DB transaction의 취소 영수증이 늦은 commit도 거부해야 한다.
    // 본문 부재/조회 일치/시간 경과를 취소 증거로 사용하지 않는다.
    if (typeof adapter.fence !== 'function') throw fail('WRITER_FENCE_UNSUPPORTED');
    const proof = await adapter.fence(clone(op));
    try { await complete(op, proof); return { status: 'completed' }; }
    catch (error) { if (error.code === 'WRITER_CANCELLED') return { status: 'cancelled' }; throw error; }
  }
  async function cancelPrepared(writer, id) {
    idCheck(id);
    await change(state => {
      matches(state, writer); const op = state.operations[id];
      if (!op || op.backend !== writer.backend || op.epoch !== writer.epoch) throw fail('WRITER_OUTCOME_UNRESOLVED');
      if (op.status === 'cancelled') return state;
      if (op.status !== 'prepared') throw fail('WRITER_OUTCOME_UNRESOLVED');
      op.status = 'cancelled'; return state;
    });
  }
  async function drain(writer) { await change(state => { matches(state, writer); state.phase = 'draining'; return state; }); return route(); }
  async function resume(writer, { id, writersDrained = false } = {}) {
    idCheck(id);
    // 이전 업무/전환 Job와 RPC의 실제 종료 확인은 호출자 책임이며 상태만으로 증명하지 않는다.
    if (writersDrained !== true) throw fail('WRITER_RESUME_CONFIRMATION_REQUIRED');
    const result = marker => {
      if (marker.backend !== writer?.backend || marker.fromEpoch !== writer?.epoch) throw fail('WRITER_RESUME_CONFLICT');
      return { backend: marker.backend, epoch: marker.toEpoch, phase: 'accepting' };
    };
    const previous = await read();
    if (previous?.lastResume?.id === id) return result(previous.lastResume);
    const state = await change(current => {
      if (current?.lastResume?.id === id) { result(current.lastResume); return current; }
      matches(current, writer);
      if (current.phase !== 'draining' || unresolved(current)) throw fail('WRITER_NOT_DRAINED');
      if (current.epoch === Number.MAX_SAFE_INTEGER) throw fail('WRITER_SEQUENCE_EXHAUSTED');
      // 진행점/영수증/이력/원본·대상은 보존한다. 새 epoch로 늦은 구형 제어 요청을 fence한다.
      current.lastResume = { id, backend: current.backend, fromEpoch: current.epoch, toEpoch: current.epoch + 1 };
      current.epoch++; current.phase = 'accepting'; return current;
    });
    await onCheckpoint('writersResumed', id);
    return result(state.lastResume);
  }
  // Auth RPC는 업무 DB의 receipt로 취소하거나 재생할 수 없다. 제출 전 영구 등록한다.
  async function beginExternal(writer, id, resources, { parentId } = {}) {
    idCheck(id);
    if (!Array.isArray(resources) || !resources.length) throw fail('WRITER_INVALID_RECORDS');
    const locks = [...new Set(resources)].sort(); locks.forEach(checkKey);
    await maintain();
    await historyGuard('external', id, async (known, version) => {
    if (known) throw fail('WRITER_OPERATION_CONFLICT');
    await change(state => {
      sameHistory(state, version);
      const parent = parentId && state?.external?.[parentId];
      if (parentId && (!parent || parent.status !== 'running' || parent.backend !== writer?.backend || parent.epoch !== writer?.epoch || locks.some(key => !parent.resources.includes(key)))) throw fail('WRITER_FENCED');
      matches(state, writer, !parent); state.external ||= {};
      if (state.external[id]) throw fail('WRITER_OPERATION_CONFLICT');
      if (Object.keys(state.operations).length + Object.keys(state.external).length >= maxOperations) throw fail('WRITER_JOURNAL_FULL');
      const pending = [...Object.values(state.operations).filter(op => ['prepared', 'executing'].includes(op.status)), ...externalPending(state).filter(op => op.id !== parentId)];
      if (pending.some(op => op.resources.some(key => locks.includes(key)))) throw fail('WRITER_RESOURCE_BUSY');
      state.external[id] = { id, backend: writer.backend, epoch: writer.epoch, resources: locks, status: 'running' }; return state;
    });
    });
  }
  async function endExternal(id, uncertain = false) {
    idCheck(id);
    await change(state => {
      const op = state.external?.[id];
      if (!op || op.status !== 'running') throw fail('WRITER_OUTCOME_UNRESOLVED');
      matches(state, op); op.status = uncertain ? 'uncertain' : 'completed'; return state;
    });
  }
  async function addExternalResources(id, resources) {
    idCheck(id);
    if (!Array.isArray(resources)) throw fail('WRITER_INVALID_RECORDS');
    resources.forEach(checkKey);
    await change(state => {
      const op = state.external?.[id];
      if (!op || op.status !== 'running') throw fail('WRITER_OUTCOME_UNRESOLVED');
      matches(state, op);
      const added = [...new Set(resources)].filter(key => !op.resources.includes(key));
      const pending = [...Object.values(state.operations).filter(item => ['prepared', 'executing'].includes(item.status)),
        ...externalPending(state).filter(item => item.id !== id)];
      if (pending.some(item => item.resources.some(key => added.includes(key)))) throw fail('WRITER_RESOURCE_BUSY');
      op.resources = [...new Set([...op.resources, ...added])].sort(); return state;
    });
  }
  async function recoverExternal(expectedId, id, resources, { writersDrained = false } = {}) {
    idCheck(expectedId); idCheck(id);
    await measure('writer.maintenance', maintain);
    return historyGuard('external', id, async (known, version) => {
    if (known && ['completed', 'recovered'].includes(known.status)) throw fail('WRITER_OPERATION_CONFLICT');
    const saved = await change(state => {
      sameHistory(state, version);
      const old = state.external?.[expectedId];
      if (writersDrained !== true || state.phase !== 'draining' || !old || !['running', 'uncertain', 'recovered'].includes(old.status)
          || fingerprint(old.resources) !== fingerprint([...new Set(resources)].sort())) throw fail('WRITER_EXTERNAL_RECOVERY_CONFIRMATION_REQUIRED');
      matches(state, old);
      if (old.status === 'recovered') {
        const next = state.external[old.recoveryId];
        if (!next || !['running', 'uncertain'].includes(next.status) || next.recoveryOf !== expectedId) throw fail('WRITER_OUTCOME_UNRESOLVED');
        next.status = 'running'; return state;
      }
      if (state.external[id] || Object.keys(state.operations).length + Object.keys(state.external).length >= maxOperations) throw fail('WRITER_JOURNAL_FULL');
      // 이전 외부 요청/인스턴스의 실제 종료 확인은 호출자 책임이다. 시간·본문 일치로 증명하지 않는다.
      old.status = 'recovered'; old.recoveryId = id;
      state.external[id] = { id, backend: state.backend, epoch: state.epoch, resources: old.resources, status: 'running', recoveryOf: expectedId }; return state;
    });
    return saved.external[expectedId].recoveryId;
    });
  }
  async function copy(writer) {
    if (plans) {
      const before = await read(); matches(before, writer);
      for (const [backend, snapshot] of Object.entries(before.frozen)) {
        if (!Array.isArray(snapshot)) continue;
        const ref = await plans.save(entriesCheck(snapshot));
        await change(state => { matches(state, writer); if (fingerprint(state.frozen[backend]) !== fingerprint(snapshot)) throw fail('WRITER_TRANSFER_CONFLICT'); state.frozen[backend] = ref; return state; });
      }
    }
    let state = await change(state => {
      matches(state, writer);
      if (!state.transfer) state.transfer = { id: randomBytes(16).toString('hex'), epoch: state.epoch,
        backend: other(state.backend), baseline: null, expected: null, applied: {}, cursor: state.floor,
        ...(plans ? { planMode: 'partitioned', baseCursor: 0,
          ...(typeof plans.collect === 'function' && Object.values(stores).every(store => typeof store.snapshotPage === 'function') ? { collectionMode: 'paged' } : {}) } : {}) };
      return state;
    });
    const transfer = state.transfer;
    if (!transfer.baseline) {
      const paged = transfer.collectionMode === 'paged';
      const baseline = paged ? await collectSnapshot(writer, transfer, state.backend, 'baseline') : entriesCheck(await stores[state.backend].snapshot());
      const destination = paged ? await collectSnapshot(writer, transfer, transfer.backend, 'destination') : entriesCheck(await stores[transfer.backend].snapshot());
      const frozen = state.frozen[transfer.backend];
      if (frozen) {
        if (paged ? (Array.isArray(frozen) ? plans.digest(frozen) : frozen.digest) !== destination.digest
          : Array.isArray(frozen) ? fingerprint(frozen) !== fingerprint(destination) : frozen.digest !== plans.digest(destination)) throw fail('WRITER_DESTINATION_CHANGED');
        if (!Array.isArray(frozen)) await plans.verify(frozen);
      } else if (paged ? await anyExisting(destination) : destination.some(entry => entry.exists)) throw fail('WRITER_DESTINATION_NOT_EMPTY');
      // 재개된 대상 수집의 옛 위치로 우회 변경을 숨기지 않는다. 반영 전에 현재 대상도 다시 대조한다.
      if (paged) {
        const audit = await collectSnapshot(writer, transfer, transfer.backend, 'destinationAudit', randomBytes(16).toString('hex'));
        if (audit.digest !== destination.digest) throw fail('WRITER_DESTINATION_CHANGED');
      }
      const baselinePlan = paged ? baseline : transfer.planMode === 'partitioned' ? await plans.save(baseline) : clone(baseline);
      const expectedPlan = paged ? destination : transfer.planMode === 'partitioned' ? await plans.save(destination) : clone(destination);
      await onCheckpoint('planPrepared', transfer.id);
      state = await change(current => {
        matches(current, writer);
        if (current.transfer?.id !== transfer.id) throw fail('WRITER_TRANSFER_CONFLICT');
        if (!current.transfer.baseline) { current.transfer.baseline = baselinePlan; current.transfer.expected = expectedPlan; }
        return current;
      });
    }
    await onCheckpoint('snapshotCaptured', transfer.id);
    await replay(writer); return inspect();
  }
  async function collectSnapshot(writer, transfer, backend, role, captureId = fingerprint({ transferId: transfer.id, role }).slice(0, 32)) {
    const transferId = transfer.id;
    if (!Number.isSafeInteger(transfer.epoch) || transfer.epoch < 1 || transfer.epoch > writer.epoch) throw fail('WRITER_TRANSFER_CONFLICT');
    const guard = async () => { const state = await read(); matches(state, writer); if (state.transfer?.id !== transferId) throw fail('WRITER_TRANSFER_CONFLICT'); };
    // 수집의 불변 context는 최초 transfer epoch를 유지한다. 제어 guard는 현행 writer epoch를 사용한다.
    const ref = await plans.collect(captureId, { transferId, backend, epoch: transfer.epoch, role,
      ...(stores[backend].snapshotLayout ? { layout: stores[backend].snapshotLayout } : {}) }, stores[backend].snapshotPage,
      { checkEntries: entriesCheck, guard, onCheckpoint });
    await checkSnapshotPlan(ref); return ref;
  }
  async function checkSnapshotPlan(ref) {
    const C = require('./membershipCsvWriterContract'), control = await plans.entry(ref, 'csv/control');
    if (control.exists) {
      if (control.value.active) C.checkSnapshot([{ ...control, value: { ...control.value, operations: {} } }, await plans.entry(ref, `csv/candidate/${control.value.active.revision}`)]);
      for (const [id, value] of Object.entries(control.value.operations || {})) if (value.status === 'completed') {
        C.checkSnapshot([{ key: `csv/operation/${id}`, exists: true, value }, await plans.entry(ref, `csv/candidate/${id}`)]);
      }
    }
    for await (const { entry } of plans.scan(ref)) if (entry.exists && entry.key.startsWith('csv/operation/') && entry.value.status === 'completed') {
      const id = C.checkCsvKey(entry.key).id; C.checkSnapshot([entry, await plans.entry(ref, `csv/candidate/${id}`)]);
    }
  }
  async function anyExisting(ref) { for await (const { entry } of plans.scan(ref)) if (entry.exists) return true; return false; }
  async function equalContents(left, right) {
    const a = plans.scan(left)[Symbol.asyncIterator](), b = plans.scan(right)[Symbol.asyncIterator]();
    let x = await a.next(), y = await b.next();
    while (!x.done || !y.done) {
      const l = x.done ? null : x.value.entry, r = y.done ? null : y.value.entry;
      if (l && r && l.key === r.key) { if (content(l) !== content(r)) throw fail('WRITER_COMPARE_FAILED'); x = await a.next(); y = await b.next(); }
      else if (l && (!r || l.key.localeCompare(r.key) < 0)) { if (l.exists) throw fail('WRITER_COMPARE_FAILED'); x = await a.next(); }
      else { if (r.exists) throw fail('WRITER_COMPARE_FAILED'); y = await b.next(); }
    }
  }
  async function apply(writer, transferId, label, entries) {
    for (let i = 0; i < entries.length; i++) {
      const state = await read(); matches(state, writer);
      const t = state.transfer, marker = `${label}:${i}`;
      if (t?.id !== transferId) throw fail('WRITER_TRANSFER_CONFLICT');
      const sequence = label.startsWith('event:') ? Number(label.slice(6)) : undefined;
      if (sequence !== undefined && sequence <= t.cursor) continue;
      if (t.planMode === 'partitioned') {
        const index = label.startsWith('base:') ? Number(label.slice(5)) : undefined;
        if (index !== undefined && index < t.baseCursor) continue;
        const entry = entries[i], projectionId = fingerprint({ transferId, marker }).slice(0, 32);
        const anticipated = clone(state);
        if (index !== undefined) anticipated.transfer.baseCursor = index + 1;
        else anticipated.transfer.applied[marker] = true;
        capacity(anticipated);
        const observed = await plans.expected(transferId, t.expected, entry.key);
        if (observed.marker === projectionId && content(observed.entry) !== content(entry)) throw fail('WRITER_REPLAY_CONFLICT');
        if (observed.marker !== projectionId) {
          const saved = await stores[t.backend].apply(projectionId, clone(entry), clone(observed.entry));
          entriesCheck([saved]); if (saved.key !== entry.key || content(saved) !== content(entry)) throw fail('WRITER_REPLAY_CONFLICT');
          await plans.checkpoint(transferId, t.expected, projectionId, saved, observed.entry);
        }
        await onCheckpoint('planCheckpointed', projectionId);
        await change(current => {
          matches(current, writer); const next = current.transfer;
          if (next?.id !== transferId) throw fail('WRITER_TRANSFER_CONFLICT');
          if (index !== undefined) {
            if (next.baseCursor > index) return current;
            if (next.baseCursor !== index) throw fail('WRITER_TRANSFER_CONFLICT'); next.baseCursor++;
          } else if (sequence > next.cursor) next.applied[marker] = true;
          return current;
        });
        await onCheckpoint('replayed', projectionId); continue;
      }
      if (t.applied[marker]) continue;
      const entry = entries[i], expected = recordMap(t.expected).get(entry.key) || absent(entry.key);
      const projectionId = fingerprint({ transferId, marker }).slice(0, 32);
      // 재생 대상 반영 전에 예상 checkpoint 크기도 검사한다.
      const anticipated = clone(state), expectedMap = recordMap(anticipated.transfer.expected);
      expectedMap.set(entry.key, { ...clone(entry), token: '9'.repeat(128) });
      anticipated.transfer.expected = [...expectedMap.values()]; anticipated.transfer.applied[marker] = true;
      capacity(anticipated);
      const saved = await stores[t.backend].apply(projectionId, clone(entry), clone(expected));
      entriesCheck([saved]);
      if (saved.key !== entry.key || content(saved) !== content(entry)) throw fail('WRITER_REPLAY_CONFLICT');
      await change(current => {
        matches(current, writer); const next = current.transfer;
        if (next?.id !== transferId) throw fail('WRITER_TRANSFER_CONFLICT');
        if (sequence !== undefined && sequence <= next.cursor) return current;
        if (next.applied[marker]) return current;
        const map = recordMap(next.expected);
        if (fingerprint(map.get(entry.key) || absent(entry.key)) !== fingerprint(expected)) throw fail('WRITER_TRANSFER_CONFLICT');
        map.set(entry.key, clone(saved)); next.expected = [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
        next.applied[marker] = true; return current;
      });
      await onCheckpoint('replayed', projectionId);
    }
  }
  async function replay(writer) {
    const initial = await read(); matches(initial, writer);
    const t = initial.transfer;
    if (!t?.baseline) throw fail('WRITER_COPY_REQUIRED');
    if (t.planMode === 'partitioned') {
      await plans.verify(t.baseline);
      for await (const { index, entry } of plans.scan(t.baseline, { start: t.baseCursor })) { entriesCheck([entry]); await apply(writer, t.id, `base:${index}`, [entry]); }
    } else await apply(writer, t.id, 'base', t.baseline);
    // 이번에 관측한 끝까지만 처리한다. 이후 새 쓰기는 다음 replay/drain에서 다룬다.
    for (const event of initial.events.filter(event => event.sequence > t.cursor)) {
      // resume는 같은 backend에서 epoch만 올린다. 전환 이후 과거 backend의 이력은 floor/cursor가 제외한다.
      if (!Number.isSafeInteger(event.epoch) || event.epoch < 1 || event.epoch > writer.epoch) throw fail('WRITER_STATE_INVALID');
      let changes = event.changes;
      if (!changes) {
        const op = await history?.get('operations', event.operationId);
        if (!op || op.status !== 'completed' || op.epoch !== event.epoch || op.capturedSequence !== event.sequence
            || fingerprint(op.receipt) !== event.receiptDigest) throw fail('WRITER_HISTORY_CONFLICT');
        changes = entriesCheck(op.receipt.changes, true);
      }
      await apply(writer, t.id, `event:${event.sequence}`, changes);
      await change(state => {
        matches(state, writer); if (state.transfer?.id !== t.id) throw fail('WRITER_TRANSFER_CONFLICT');
        state.transfer.cursor = Math.max(state.transfer.cursor, event.sequence); return state;
      });
    }
    return inspect();
  }
  async function activate(writer) {
    let state = await read(); matches(state, writer);
    if (state.phase !== 'draining' || unresolved(state)) throw fail('WRITER_NOT_DRAINED');
    await replay(writer);
    state = await read(); matches(state, writer);
    const paged = state.transfer.collectionMode === 'paged';
    const source = paged ? await collectSnapshot(writer, state.transfer, state.backend, 'sourceAudit', randomBytes(16).toString('hex')) : entriesCheck(await stores[state.backend].snapshot());
    const target = paged ? await collectSnapshot(writer, state.transfer, state.transfer.backend, 'targetAudit', randomBytes(16).toString('hex')) : entriesCheck(await stores[state.transfer.backend].snapshot());
    let frozen;
    if (state.transfer.planMode === 'partitioned') {
      if (state.transfer.baseCursor !== state.transfer.baseline.count) throw fail('WRITER_NOT_DRAINED');
      const expected = await plans.sealExpected(state.transfer.id, state.transfer.expected);
      if (expected.digest !== (paged ? target.digest : plans.digest(target))) throw fail('WRITER_DESTINATION_CHANGED');
      frozen = paged ? source : await plans.save(source);
    } else {
      if (fingerprint(state.transfer.expected) !== fingerprint(target)) throw fail('WRITER_DESTINATION_CHANGED');
      frozen = plans ? await plans.save(source) : clone(source);
    }
    if (paged) await equalContents(source, target);
    else {
      const src = recordMap(source), dst = recordMap(target);
      if ([...new Set([...src.keys(), ...dst.keys()])].some(key => content(src.get(key)) !== content(dst.get(key)))) throw fail('WRITER_COMPARE_FAILED');
    }
    await change(current => {
      matches(current, writer);
      if (current.phase !== 'draining' || unresolved(current) || current.sequence !== state.sequence
          || current.transfer?.id !== state.transfer.id || current.transfer.cursor !== current.sequence) throw fail('WRITER_NOT_DRAINED');
      if (current.epoch === Number.MAX_SAFE_INTEGER) throw fail('WRITER_SEQUENCE_EXHAUSTED');
      current.frozen[current.backend] = frozen;
      current.backend = other(current.backend); current.epoch++; current.floor = current.sequence;
      current.phase = 'accepting'; current.transfer = null; return current;
    });
    return route();
  }
  function protectedPlanIds(state) {
    const ids = new Set(), seen = new Set();
    function visit(value) {
      if (typeof value === 'string') { if (/^[a-f0-9]{32}$/.test(value)) ids.add(value); return; }
      if (!value || typeof value !== 'object' || seen.has(value)) return; seen.add(value);
      for (const item of Object.values(value)) visit(item);
    }
    // 현재 frozen 외의 향후 참조와 사용자 값에 든 같은 모양의 ID도 보수적으로 보호한다.
    visit(state); return ids;
  }
  async function previewPlanCleanup(writer, { beforeEpoch, limit = 32 } = {}) {
    const state = await read(); matches(state, writer);
    if (!plans?.cleanup || state.transfer || unresolved(state)) throw fail('WRITER_NOT_DRAINED');
    const result = await plans.cleanup.candidates({ beforeEpoch, currentEpoch: state.epoch, protectedIds: protectedPlanIds(state), limit });
    return { selected: result.items.length, scanned: result.scanned, retained: result.retained, hasMore: result.hasMore };
  }
  async function cleanupPlans(writer, { id, beforeEpoch, limit = 32, writersDrained = false } = {}) {
    idCheck(id); if (writersDrained !== true || !plans?.cleanup) throw fail('WRITER_NOT_DRAINED');
    let state = await read(); if (!state || state.backend !== writer?.backend || state.epoch !== writer?.epoch) throw fail('WRITER_FENCED');
    let job = await plans.cleanup.job(id);
    if (job && (job.backend !== writer.backend || job.epoch !== writer.epoch || job.beforeEpoch !== beforeEpoch || job.limit !== limit)) throw fail('WRITER_PLAN_CLEANUP_CONFLICT');
    if (state.planMaintenance && state.planMaintenance.id !== id) throw fail('WRITER_PLAN_MAINTENANCE');
    if (!job) {
      matches(state, writer); if (state.transfer || unresolved(state)) throw fail('WRITER_NOT_DRAINED');
      const result = await plans.cleanup.candidates({ beforeEpoch, currentEpoch: state.epoch, protectedIds: protectedPlanIds(state), limit });
      job = await plans.cleanup.prepare(id, { format: 1, id, backend: state.backend, epoch: state.epoch, beforeEpoch, limit, previousPhase: state.phase,
        items: result.items, scanned: result.scanned, retained: result.retained, hasMore: result.hasMore, cursor: 0, status: 'prepared' });
    }
    function checkHold(current) {
      if (!current || current.backend !== job.backend || current.epoch !== job.epoch || current.transfer || unresolved(current)
          || current.planMaintenance?.id !== id || current.planMaintenance.previousPhase !== job.previousPhase) throw fail('WRITER_PLAN_CLEANUP_CONFLICT');
    }
    if (job.status !== 'completed') {
      state = await change(current => {
        if (current.planMaintenance) { checkHold(current); return current; }
        matches(current, writer); if (current.transfer || unresolved(current) || current.phase !== job.previousPhase) throw fail('WRITER_NOT_DRAINED');
        current.planMaintenance = { id, backend: current.backend, epoch: current.epoch, previousPhase: current.phase }; current.phase = 'draining'; return current;
      });
      await onCheckpoint('planCleanupLocked', id);
      for (let n = job.cursor; n < job.items.length; n++) {
        await plans.cleanup.removeScope(job.items[n], id, async item => {
          const current = await read(); checkHold(current);
          if (item.context.epoch >= job.beforeEpoch || item.context.epoch >= current.epoch || protectedPlanIds(current).has(item.id)) throw fail('WRITER_PLAN_CLEANUP_CONFLICT');
        }, onCheckpoint);
        job = await plans.cleanup.advance(id, n + 1); await onCheckpoint('planCleanupCheckpointed', id);
      }
      job = await plans.cleanup.advance(id, job.items.length, true); await onCheckpoint('planCleanupCompleted', id);
    }
    state = await read();
    if (state.planMaintenance) await change(current => { checkHold(current); current.phase = current.planMaintenance.previousPhase; delete current.planMaintenance; return current; });
    return { selected: job.items.length, removed: job.cursor, scanned: job.scanned, retained: job.retained, hasMore: job.hasMore };
  }
  async function inspect() {
    const state = await read(); if (!state) throw fail('WRITER_NOT_INITIALIZED');
    return { backend: state.backend, epoch: state.epoch, phase: state.phase,
      unresolved: Object.values(state.operations).filter(op => ['prepared', 'executing'].includes(op.status)).length + externalPending(state).length,
      externalUnresolved: externalPending(state).length,
      captured: state.sequence, replayed: state.transfer?.cursor ?? state.floor, copying: !!state.transfer };
  }
  async function isExternalSettled(id, resources) {
    idCheck(id);
    if (!Array.isArray(resources) || !resources.length) throw fail('WRITER_INVALID_RECORDS');
    resources.forEach(checkKey);
    const operation = typeof journal.readExternal === 'function' ? await journal.readExternal(runId, id) : (await read())?.external?.[id];
    const op = operation || await history?.get('external', id);
    return !!op && op.id === id && op.status === 'completed' && ['legacy', 'rtdb'].includes(op.backend)
      && Number.isSafeInteger(op.epoch) && op.epoch > 0 && Array.isArray(op.resources)
      && resources.every(key => op.resources.includes(key));
  }
  const executeWithReceipt = (writer, id) => execute(writer, id, true);
  const withSession = action => journal.withSession ? journal.withSession(action) : action();
  const methods = { runId, initialize, route, prepare, execute, executeWithReceipt, prepareAndExecuteWithReceipt, recover, fenceUncommitted, cancelPrepared, drain, resume, copy, replay, activate, inspect,
    beginExternal, endExternal, addExternalResources, recoverExternal, compact, historyStatus, previewPlanCleanup, cleanupPlans, isExternalSettled, withSession };
  // 조회/전환 관리 호출에는 다음 요청까지 유지되는 snapshot 캐시를 만들지 않는다.
  for (const name of ['prepare', 'execute', 'executeWithReceipt', 'prepareAndExecuteWithReceipt', 'recover', 'beginExternal', 'endExternal']) {
    const method = methods[name]; methods[name] = (...args) => withSession(() => method(...args));
  }
  const prepareMethod = methods.prepare;
  methods.prepare = (...args) => measure('writer.prepare', () => prepareMethod(...args));
  return methods;
}

// epoch를 고정한다. 새 route에 자동 재전송하여 기존 처리를 중복 실행하지 않는다.
function createTransitionWriter(coordinator, writer) {
  return { async write(id, changes, result = null, options) {
    const action = async () => { await coordinator.prepare(writer, id, changes, result, options); return coordinator.execute(writer, id); };
    return coordinator.withSession ? coordinator.withSession(action) : action();
  } };
}
module.exports = { createUserWriterTransition, createTransitionWriter };
