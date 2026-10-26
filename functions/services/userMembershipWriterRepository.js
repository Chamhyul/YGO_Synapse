'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomBytes } = require('node:crypto');
const { encodeValue, decodeValue } = require('./user-storage/codec');
const { validateVerificationState, validateMembership, membershipVersion } = require('./user-storage/membershipStore');
const { checkVerificationKey } = require('./userMembershipWriterAdapters');
const { accountResource } = require('./user-storage/accountResource');
const { measure } = require('./inventoryRequestTiming');
const fail = code => Object.assign(new Error('멤버십 인증 상태를 확인하고 다시 요청해 주세요.'), { code });
const clone = value => decodeValue(encodeValue(value));
const leaseFailureCodes = new Set(['WRITER_RESOURCE_BUSY', 'WRITER_FENCED', 'WRITER_DRAINING', 'WRITER_PLAN_MAINTENANCE',
  'WRITER_JOURNAL_FULL', 'WRITER_HISTORY_CHANGED', 'WRITER_HISTORY_CONFLICT', 'WRITER_OPERATION_CONFLICT',
  'WRITER_STATE_INVALID', 'WRITER_PLAN_STORE_REQUIRED', 'WRITER_HISTORY_REQUIRED', 'WRITER_INVALID_RECORDS',
  'USER_STORAGE_CONFLICT', 'USER_STORAGE_WRITE_AMBIGUOUS', 'USER_STORAGE_READ_TIMEOUT']);
function reportLeaseFailure(error) {
  try { console.warn(JSON.stringify({ event: 'membership_lease_failure', stage: 'begin',
    code: leaseFailureCodes.has(error?.code) ? error.code : 'UNCLASSIFIED',
    kind: ['TypeError', 'RangeError'].includes(error?.name) ? error.name : 'Error' })); } catch (_) { /* 진단 실패는 업무에 영향을 주지 않는다. */ }
}
function createMembershipWriterRepository({ transition, adapters, profiles, initialize, initializeMissing = true, timeoutMs = 10000 }) {
  const request = new AsyncLocalStorage();
  const activeLease = uid => { const lease = request.getStore(); return lease?.active && lease.uid === uid ? lease : undefined; };
  const result = profile => { const membership = profile.value?.settings?.membership; return { membership, version: membershipVersion(membership) }; };
  async function mutate(uid, provider, action, propose) {
    checkVerificationKey(`verification/${provider}/${uid}`);
    const lease = activeLease(uid), initialized = lease ? undefined : await initialize();
    const writer = lease?.writer || (initializeMissing ? await transition.route() : initialized);
    if (lease) lease.completed = false;
    const work = async () => {
    const deadline = Date.now() + timeoutMs; let conflicts = 0;
    while (Date.now() < deadline) {
      const current = await measure('membership.context', () => adapters[writer.backend].context(uid, provider)), candidate = propose(current);
      const reserved = lease?.operationIds?.[action];
      if (reserved) delete lease.operationIds[action];
      const id = reserved || randomBytes(16).toString('hex'); let op;
      try {
        const options = {
          resources: [`fs/users/${uid}`, `inventory/${uid}`],
          details: { kind: 'membership', action, profileToken: current.profile.token }, parentExternal: lease?.id,
        };
        if (lease?.fused && (action === 'consume' && !lease.admitted || action === 'complete' && lease.deferClaims)) {
          const saved = await transition.prepareAndExecuteMembershipWithReceipt(writer, id, candidate.changes, candidate.result, {
            ...options, admitParent: action === 'consume' && !lease.admitted, finishParent: action === 'complete' && lease.deferClaims,
            onPrepared(value) { op = value; lease.admitted = true; lease.onAdmitted(); },
            onParentCompleted() { lease.released = true; },
          });
          return saved.result;
        }
        if (typeof transition.prepareAndExecuteWithReceipt === 'function') {
          const saved = await transition.prepareAndExecuteWithReceipt(writer, id, candidate.changes, candidate.result,
            { ...options, onPrepared: value => { op = value; } });
          return saved.result;
        }
        op = await transition.prepare(writer, id, candidate.changes, candidate.result, options);
        return await transition.execute(writer, id);
      }
      catch (error) {
        if (!op && error.code === 'WRITER_RESOURCE_BUSY') {
          if (lease?.fused && !lease.admitted) throw error;
          await new Promise(resolve => setTimeout(resolve, 20)); continue;
        }
        if (error.code !== 'WRITER_CANCELLED') throw error;
        if (!op) throw error;
        const reason = await adapters[writer.backend].cancellationReason(op);
        if (reason === 'expired') throw fail('MEMBERSHIP_VERIFICATION_EXPIRED');
        if (reason !== 'conflict' || ++conflicts >= 3) throw error;
      }
    }
    throw fail('USER_STORAGE_QUEUE_TIMEOUT');
    };
    return adapters[writer.backend].withSession ? adapters[writer.backend].withSession(work) : work();
  }
  function active(current, nonceHash, at, consumed) {
    const time = typeof at === 'function' ? at() : at;
    if (typeof nonceHash !== 'string' || !/^[a-f0-9]{64}$/.test(nonceHash) || !Number.isSafeInteger(time) || time < 0) throw fail('USER_STORAGE_INVALID_MEMBERSHIP_STATE');
    const state = current.nonce.value;
    if (!state || state.nonceHash !== nonceHash || state.completed || state.consumed !== consumed
        || state.expiresAt <= time || state.profileGeneration !== current.generation) throw fail('MEMBERSHIP_VERIFICATION_EXPIRED');
    return state;
  }
  return {
    writerLease: () => { const lease = request.getStore(); return lease?.active && lease.admitted && !lease.released ? { writer: clone(lease.writer), id: lease.id } : undefined; },
    // 확정된 요청의 backend 정보이며, 이미 종료된 잠금의 쓰기 권한을 제공하지 않는다.
    verificationWriter: () => { const lease = request.getStore(); return lease?.active && lease.admitted ? clone(lease.writer) : undefined; },
    async withClaimsWriteWindow(uid, action) {
      checkVerificationKey(`verification/youtube/${uid}`);
      const lease = activeLease(uid);
      if (!lease?.completed || lease.released) return { used: false };
      const before = await measure('claims.route_before', () => transition.route());
      const matches = writer => writer.backend === lease.writer.backend && writer.epoch === lease.writer.epoch
        && ['accepting', 'draining'].includes(writer.phase);
      if (!matches(before)) throw fail('WRITER_FENCED');
      let active = true;
      try {
        const read = async () => {
          if (!active || !lease.active) throw fail('WRITER_FENCED');
          const profile = await profiles[before.backend].read(`fs/users/${uid}`);
          if (!active || !lease.active) throw fail('WRITER_FENCED');
          return result(profile);
        };
        const value = await action({ read });
        const after = await measure('claims.route_after', () => transition.route());
        if (!matches(after) || !lease.active) throw fail('WRITER_FENCED');
        return { used: true, value };
      } finally { active = false; }
    },
    // 읽기 전용 claims 대조 전체를 한 전환 구간으로 감싼다. 원본은 호출마다
    // 서버에서 다시 읽으며 종료 뒤에는 read 함수를 재사용하지 못한다.
    async withReadWindow(uid, action) {
      checkVerificationKey(`verification/youtube/${uid}`);
      const before = await measure('claims.route_before', () => transition.route());
      let active = true;
      try {
        const read = async () => {
          if (!active) throw fail('WRITER_FENCED');
          const profile = await profiles[before.backend].read(`fs/users/${uid}`);
          if (!active) throw fail('WRITER_FENCED');
          return result(profile);
        };
        const value = await action({ writer: before, read });
        const after = await measure('claims.route_after', () => transition.route());
        if (before.backend !== after.backend || before.epoch !== after.epoch || before.phase !== after.phase) throw fail('WRITER_FENCED');
        return value;
      } finally { active = false; }
    },
    async withVerification(uid, provider, action, { consume, deferClaims = false } = {}) {
      checkVerificationKey(`verification/${provider}/${uid}`); const initialized = await initialize();
      const writer = initializeMissing ? await transition.route() : initialized, id = randomBytes(16).toString('hex');
      const deadline = Date.now() + timeoutMs;
      let retries = 0;
      while (true) {
        let acquired = false;
        const operationIds = { consume: randomBytes(16).toString('hex'), complete: randomBytes(16).toString('hex') };
        const work = async () => {
          const fused = !!consume && typeof transition.prepareAndExecuteMembershipWithReceipt === 'function';
          if (!fused) {
            await measure('membership.lease_begin', () => transition.beginExternal(writer, id, [`fs/users/${uid}`, `inventory/${uid}`, `verification/${provider}/${uid}`, accountResource(uid)]));
            acquired = true;
          }
          const lease = { writer, id, uid, active: true, completed: false, operationIds, fused, admitted: acquired,
            deferClaims: deferClaims === true && writer.backend === 'rtdb', onAdmitted() { acquired = true; } };
          try { return await request.run(lease, async () => {
            if (fused) {
              // 상위 잠금과 일회 소비 명령을 함께 확정한 뒤에만 OAuth 작업을 실행한다.
              const state = await measure('membership.consume', () => mutate(uid, provider, 'consume', current => {
                const value = { ...active(current, consume.nonceHash, consume.at ?? Date.now, false), consumed: true };
                return { changes: [{ ...current.nonce, value }], result: value };
              }));
              lease.consumed = { provider, nonceHash: consume.nonceHash, state };
            }
            return action();
          }); }
          finally {
            lease.active = false;
            if (lease.admitted && !lease.released) await measure('membership.lease_end', () => transition.endExternal(id));
          }
        };
        try {
          // 실패한 잠금 시도의 세션을 먼저 끝내고 다음 시도는 fresh journal로 시작한다.
          // 확보 후의 업무·종료 ACK 실패는 이 반복으로 재실행하지 않는다.
          const prepareReads = () => consume && transition.withMembershipAdmissionReads
            ? transition.withMembershipAdmissionReads(id, operationIds.consume, prime => { prime(); return work(); }) : work();
          const prefetch = () => transition.withOperationHistoryPrefetch
            ? transition.withOperationHistoryPrefetch(Object.values(operationIds), prepareReads) : prepareReads();
          const run = () => transition.withSession ? transition.withSession(prefetch) : prefetch();
          const adapter = adapters[writer.backend];
          return await (adapter.withVerificationSession ? adapter.withVerificationSession(run, uid, provider) : run());
        } catch (error) {
          if (acquired) throw error;
          if (error.code !== 'WRITER_RESOURCE_BUSY' || Date.now() >= deadline) { reportLeaseFailure(error); throw error; }
          const delay = Math.min(50 * 2 ** Math.min(retries++, 3), 250, deadline - Date.now());
          await measure('membership.lease_wait', () => new Promise(resolve => setTimeout(resolve, Math.max(0, delay))));
          if (Date.now() >= deadline) { reportLeaseFailure(error); throw error; }
        }
      }
    },
    async read(uid) {
      const initialized = await initialize();
      for (let i = 0; i < 3; i++) {
        const before = i === 0 && !initializeMissing ? initialized : await transition.route();
        const profile = await profiles[before.backend].read(`fs/users/${uid}`), after = await transition.route();
        if (before.backend === after.backend && before.epoch === after.epoch) return result(profile);
      }
      throw fail('WRITER_FENCED');
    },
    start(uid, provider, state) {
      const stable = validateVerificationState(state, provider, false);
      return mutate(uid, provider, 'start', current => {
        if (current.nonce.exists && stable.startedAt - current.nonce.value.startedAt < 3000) throw fail('MEMBERSHIP_TOO_MANY_REQUESTS');
        const value = { ...stable, consumed: false, completed: false, profileGeneration: current.generation };
        return { changes: [{ ...current.nonce, exists: true, value }], result: value };
      });
    },
    consume(uid, provider, nonceHash, at = Date.now) {
      const lease = activeLease(uid), cached = lease?.consumed;
      if (cached && cached.provider === provider && cached.nonceHash === nonceHash) {
        delete lease.consumed;
        const time = typeof at === 'function' ? at() : at;
        if (!Number.isSafeInteger(time) || time < 0) throw fail('USER_STORAGE_INVALID_MEMBERSHIP_STATE');
        if (cached.state.expiresAt <= time) throw fail('MEMBERSHIP_VERIFICATION_EXPIRED');
        return Promise.resolve(clone(cached.state));
      }
      return mutate(uid, provider, 'consume', current => {
        const value = { ...active(current, nonceHash, at, false), consumed: true };
        return { changes: [{ ...current.nonce, value }], result: value };
      });
    },
    async complete(uid, provider, nonceHash, membership, at = Date.now) {
      const stable = validateMembership(membership, provider);
      const saved = await mutate(uid, provider, 'complete', current => {
        const state = active(current, nonceHash, at, true), changes = [{ ...current.nonce, value: { ...state, completed: true } }];
        let profile = current.profile;
        if (!state.localOnly) {
          if (current.tombstone) throw fail('MEMBERSHIP_VERIFICATION_EXPIRED');
          const value = clone(profile.value ?? {});
          if (value.settings !== undefined && (!value.settings || typeof value.settings !== 'object' || Array.isArray(value.settings))) throw fail('USER_STORAGE_INVALID_MEMBERSHIP');
          profile = { ...profile, exists: true, value: { ...value, settings: { ...value.settings, membership: stable } } };
          changes.push(profile);
        }
        const summary = result(profile);
        return { changes, result: { ...(summary.membership === undefined ? {} : { membership: summary.membership }), version: summary.version, stored: !state.localOnly } };
      });
      const lease = activeLease(uid);
      if (lease && saved.stored) lease.completed = true;
      return { membership: saved.membership, version: saved.version, stored: saved.stored };
    },
  };
}
module.exports = { createMembershipWriterRepository };
