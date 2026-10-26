'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomBytes } = require('node:crypto');
const { sessionValue, checkHash, IDLE_MS } = require('./user-storage/adminSessionStore');
const { accountResource } = require('./user-storage/accountResource');
const fail = code => Object.assign(new Error('관리자 세션의 전환 상태를 확인하고 다시 로그인해 주세요.'), { code });
const id = () => randomBytes(16).toString('hex');
function createSessionWriterRepository({ transition, adapters, initialize, initializeMissing = true, timeoutMs = 10000 }) {
  const observations = new WeakMap(), requests = new AsyncLocalStorage();
  const keyFor = hash => { checkHash(hash); return `session/${hash}`; };
  // 활동 갱신은 세션만 변경한다. 발급·삭제·그 외 쓰기의 계정 잠금은 유지한다.
  const resources = (key, uid, sessionOnly = false) => [key, ...(uid && !sessionOnly ? [accountResource(uid)] : [])];
  const writable = () => { if (requests.getStore()?.readOnly) throw fail('SESSION_WRITER_READ_ONLY'); };
  async function lease(locks) {
    writable();
    const request = requests.getStore(); if (!request) return;
    const missing = locks.filter(key => !request.resources.has(key));
    if (request.id && !missing.length) return;
    const candidate = request.id || id(), deadline = Date.now() + timeoutMs;
    while (true) {
      try {
        if (!request.id) await transition.beginExternal(request.writer, candidate, [`sessionRequest/${candidate}`, ...locks]);
        else await transition.addExternalResources(request.id, missing);
        request.id = candidate;
        for (const key of locks) request.resources.add(key);
        return;
      } catch (error) {
        if (error.code !== 'WRITER_RESOURCE_BUSY' || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
  }
  async function selected() {
    const request = requests.getStore();
    if (request) return request.writer;
    const initialized = await initialize();
    // 운영 초기화는 이번 호출의 fresh route다. 시험 초기화의 캐시된 route는 재사용하지 않는다.
    return initializeMissing ? transition.route() : initialized;
  }
  const combinedAdmission = () => requests.getStore()?.activityOnly === true
    && !requests.getStore().id && typeof transition.prepareAndExecuteActivityAdmissionWithReceipt === 'function';
  async function read(hash) {
    const key = keyFor(hash);
    if (combinedAdmission()) requests.getStore().primeAdmission?.();
    for (let i = 0; i < 3; i++) {
      const writer = await selected(); let current = await adapters[writer.backend].inspect(key);
      const after = await transition.route();
      if (writer.backend !== after.backend || writer.epoch !== after.epoch) {
        if (requests.getStore()) throw fail('WRITER_FENCED'); continue;
      }
      if (requests.getStore()?.readOnly && after.phase !== 'accepting') throw fail('WRITER_DRAINING');
      if (current.entry.exists && !requests.getStore()?.readOnly && !combinedAdmission()) {
        await lease(resources(key, current.entry.value.uid, requests.getStore()?.activityOnly === true));
        // 잠금을 기다리는 사이 logout/touch가 끝났을 수 있다. 확보 뒤의 값을 판정한다.
        if (requests.getStore()?.id) current = await adapters[writer.backend].inspect(key);
      }
      return { writer, current };
    }
    throw fail('WRITER_FENCED');
  }
  async function publish(writer, entry, action, result, extra = {}) {
    const locks = resources(entry.key, entry.value?.uid || extra.uid,
      action === 'touch' && requests.getStore()?.activityOnly === true);
    const admission = action === 'touch' && combinedAdmission();
    if (!admission) await lease(locks);
    const plan = admission ? requests.getStore().admissionPlan : undefined;
    if (admission) delete requests.getStore().admissionPlan;
    const operationId = plan?.operation || id(); let op; const started = Date.now(), expires = started + timeoutMs;
    const context = requests.getStore(), fused = admission || action === 'touch' && context?.activityOnly === true
      && typeof transition.prepareAndExecuteActivityWithReceipt === 'function';
    const parentId = admission ? plan?.parent || id() : context?.id;
    const execute = admission ? transition.prepareAndExecuteActivityAdmissionWithReceipt
      : fused ? transition.prepareAndExecuteActivityWithReceipt : transition.prepareAndExecuteWithReceipt;
    if (typeof execute === 'function') {
      while (true) {
        try {
          // 잠금 대기 중 만료된 세션을 오래된 요청 시각으로 연장하지 않는다.
          if (admission && Date.now() > started && (entry.value.expiresAt <= extra.at + Date.now() - started
              || extra.at + Date.now() - started - entry.value.lastActivity >= IDLE_MS)) return { cancelled: 'inactive' };
          const completed = await execute(writer, operationId, [entry], result, {
            resources: locks, details: { kind: 'session', action, ...extra },
            parentExternal: parentId, onPrepared: value => {
              op = value;
              if (admission) { context.id = parentId; locks.forEach(key => context.resources.add(key)); }
              if (fused) context.activityPending = true;
            },
            ...(fused ? { onParentCompleted: parent => {
              if (parent !== context.id) throw fail('WRITER_FENCED');
              context.parentCompleted = true; context.activityPending = false;
            } } : {}),
          });
          return { value: completed.result };
        } catch (error) {
          if (error.code === 'WRITER_RESOURCE_BUSY' && !op && Date.now() < expires) {
            await new Promise(resolve => setTimeout(resolve, 20)); continue;
          }
          if (error.code === 'WRITER_CANCELLED' && op) {
            if (fused) context.activityPending = false;
            return { cancelled: await adapters[writer.backend].cancellationReason(op) || 'fenced' };
          }
          throw error;
        }
      }
    }
    // 공통 단일 CAS를 제공하지 않는 기존 주입 저장소의 계약은 유지한다.
    while (!op) {
      try { op = await transition.prepare(writer, operationId, [entry], result, { resources: locks,
        details: { kind: 'session', action, ...extra }, parentExternal: requests.getStore()?.id }); }
      catch (error) { if (error.code !== 'WRITER_RESOURCE_BUSY' || Date.now() >= expires) throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    try { return { value: await transition.execute(writer, operationId) }; }
    catch (error) {
      if (error.code !== 'WRITER_CANCELLED') throw error;
      return { cancelled: await adapters[writer.backend].cancellationReason(op) || 'fenced' };
    }
  }
  async function withWriter(writer, action, context = { writer, resources: new Set() }, reuseJournal = false) {
    const run = () => requests.run(context, async () => {
      try { return await action(); }
      finally {
        // 합성 ACK가 있으면 종료를 반복하지 않는다. 미확정 명령은 상위 요청과 함께 복구한다.
        if (context.id && !context.parentCompleted && !context.activityPending) await transition.endExternal(context.id);
      }
    });
    // 짧은 읽기 승인 안에서만 native CAS의 확정 revision/구독을 재사용한다.
    // 충돌은 journal의 기존 fresh 조회·서버 CAS 경계로 처리한다.
    const native = () => context.activityOnly && adapters[writer.backend].withSession
      ? adapters[writer.backend].withSession(run) : run();
    const prepared = () => context.activityOnly && typeof transition.prepareAndExecuteActivityAdmissionWithReceipt === 'function'
      && typeof transition.withActivityAdmissionReads === 'function' ? (() => {
        const plan = context.admissionPlan = { parent: id(), operation: id() };
        return transition.withActivityAdmissionReads(plan.parent, plan.operation, prime => {
          context.primeAdmission = prime; return native();
        });
      })() : native();
    return reuseJournal && transition.withSession ? transition.withSession(prepared) : prepared();
  }
  return {
    writerLease: () => requests.getStore(),
    async withRequest(req, action, { reuseJournal = false, activityOnly = false } = {}) {
      const writer = await selected();
      return withWriter(writer, action, { writer, resources: new Set(), sessions: new Map(), activityOnly: activityOnly === true }, reuseJournal);
    },
    async withReadRequest(req, authorize, action, { document = false } = {}) {
      // 읽기는 journal/계정 잠금을 쓰지 않는다. 수집 뒤 현재 권한과 세션을
      // 다시 읽어 같은 backend/epoch·세대의 결과만 반환한다.
      const writer = await selected();
      const first = { writer, readOnly: true, resources: new Set(), sessions: new Map() };
      const access = await requests.run(first, () => authorize({ readOnly: true, identityOnly: document }));
      if (!access) return { access: null };
      const result = await action(access);
      // Auth 조회 도중 완료된 logout/재발급도 마지막 세션 재조회에서 거부한다.
      // journal 구독 캐시 없이 서버의 세션·route를 매번 읽는다.
      const last = { writer, readOnly: true, resources: new Set(), expectedSessions: first.sessions };
      const confirmed = await requests.run(last, () => authorize({ readOnly: true, confirmSession: true,
        ...(document ? { sessionObservation: access } : {}) }));
      return confirmed?.uid === access.uid && (document || confirmed.role === access.role) ? { access: confirmed, result } : { access: null };
    },
    async beginLogin(uid, oldHash) {
      writable();
      if (!requests.getStore()) throw fail('SESSION_WRITER_REQUEST_REQUIRED');
      const locks = [accountResource(uid)];
      if (oldHash) {
        const key = keyFor(oldHash), writer = await selected(), previous = await adapters[writer.backend].inspect(key);
        locks.push(key); if (previous.entry.exists) locks.push(accountResource(previous.entry.value.uid));
      }
      await lease(locks);
    },
    async get(hash) {
      const { writer, current } = await read(hash); if (!current.entry.exists) return undefined;
      const request = requests.getStore(), key = keyFor(hash);
      const expected = request?.expectedSessions?.get(key);
      if (expected && expected.generation !== current.generation) return undefined;
      request?.sessions?.set(key, { generation: current.generation });
      const value = current.entry.value; observations.set(value, { key: keyFor(hash), writer, token: current.entry.token }); return value;
    },
    async set(hash, value) {
      writable();
      const stable = sessionValue(value), writer = await selected(), key = keyFor(hash); let generation;
      for (let i = 0; i < 3; i++) {
        const current = await adapters[writer.backend].inspect(key); generation ??= current.generation;
        if (current.generation !== generation) throw fail('USER_STORAGE_CONFLICT');
        const result = await publish(writer, { key, exists: true, token: current.entry.token, value: stable }, 'set', null);
        if (!result.cancelled) return;
        if (result.cancelled !== 'conflict') throw fail('WRITER_CANCELLED');
      }
      throw fail('USER_STORAGE_CONFLICT');
    },
    async remove(hash, observedValue) {
      writable();
      const conditional = arguments.length > 1, key = keyFor(hash), observed = conditional && observations.get(observedValue);
      if (conditional && (!observed || observed.key !== key)) throw fail('USER_STORAGE_INVALID_SESSION_OBSERVATION');
      const writer = await selected();
      if (conditional && (writer.backend !== observed.writer.backend || writer.epoch !== observed.writer.epoch)) return false;
      for (let i = 0; i < 3; i++) {
        const current = await adapters[writer.backend].inspect(key);
        if (!current.entry.exists || conditional && current.entry.token !== observed.token) return false;
        const result = await publish(writer, { key, exists: false, token: current.entry.token }, 'remove', true, { uid: current.entry.value.uid });
        if (!result.cancelled) return true;
        if (result.cancelled !== 'conflict') throw fail('WRITER_CANCELLED');
        if (conditional) return false;
      }
      throw fail('USER_STORAGE_CONFLICT');
    },
    async touch(hash, uid, at) {
      writable();
      keyFor(hash);
      if (typeof uid !== 'string' || !uid || uid.length > 128 || Buffer.from(uid).toString() !== uid) return false;
      if (!Number.isSafeInteger(at) || at < 0) throw fail('USER_STORAGE_INVALID_SESSION_TIME');
      const writer = await selected(), key = keyFor(hash); let generation = requests.getStore()?.sessions?.get(key)?.generation;
      for (let i = 0; i < 3; i++) {
        const current = await adapters[writer.backend].inspect(key), value = current.entry.value; generation ??= current.generation;
        if (!current.entry.exists || current.generation !== generation || value.uid !== uid || value.expiresAt <= at || at - value.lastActivity >= IDLE_MS) return false;
        if (value.lastActivity >= at) return true;
        const result = await publish(writer, { ...current.entry, value: { ...value, lastActivity: at } }, 'touch', true, { uid, at });
        if (!result.cancelled) return true;
        if (result.cancelled === 'inactive') return false;
        if (result.cancelled !== 'conflict') throw fail('WRITER_CANCELLED');
      }
      throw fail('USER_STORAGE_CONFLICT');
    },
  };
}
module.exports = { createSessionWriterRepository };
