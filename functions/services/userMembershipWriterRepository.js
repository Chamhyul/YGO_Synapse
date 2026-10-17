'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomBytes } = require('node:crypto');
const { encodeValue, decodeValue } = require('./user-storage/codec');
const { validateVerificationState, validateMembership, membershipVersion } = require('./user-storage/membershipStore');
const { checkVerificationKey } = require('./userMembershipWriterAdapters');
const { accountResource } = require('./user-storage/accountResource');
const fail = code => Object.assign(new Error('멤버십 인증 상태를 확인하고 다시 요청해 주세요.'), { code });
const clone = value => decodeValue(encodeValue(value));
function createMembershipWriterRepository({ transition, adapters, profiles, initialize, initializeMissing = true, timeoutMs = 10000 }) {
  const request = new AsyncLocalStorage();
  const result = profile => { const membership = profile.value?.settings?.membership; return { membership, version: membershipVersion(membership) }; };
  async function mutate(uid, provider, action, propose) {
    checkVerificationKey(`verification/${provider}/${uid}`); const initialized = await initialize();
    const writer = request.getStore()?.writer || (initializeMissing ? await transition.route() : initialized);
    const deadline = Date.now() + timeoutMs; let conflicts = 0;
    while (Date.now() < deadline) {
      const current = await adapters[writer.backend].context(uid, provider), candidate = propose(current);
      const id = randomBytes(16).toString('hex'); let op;
      try {
        op = await transition.prepare(writer, id, candidate.changes, candidate.result, {
          resources: [`fs/users/${uid}`, `inventory/${uid}`],
          details: { kind: 'membership', action, profileToken: current.profile.token }, parentExternal: request.getStore()?.id,
        });
      } catch (error) { if (error.code !== 'WRITER_RESOURCE_BUSY') throw error; await new Promise(resolve => setTimeout(resolve, 20)); continue; }
      try { return await transition.execute(writer, id); }
      catch (error) {
        if (error.code !== 'WRITER_CANCELLED') throw error;
        const reason = await adapters[writer.backend].cancellationReason(op);
        if (reason === 'expired') throw fail('MEMBERSHIP_VERIFICATION_EXPIRED');
        if (reason !== 'conflict' || ++conflicts >= 3) throw error;
      }
    }
    throw fail('USER_STORAGE_QUEUE_TIMEOUT');
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
    writerLease: () => request.getStore(),
    async withVerification(uid, provider, action) {
      checkVerificationKey(`verification/${provider}/${uid}`); const initialized = await initialize();
      const writer = initializeMissing ? await transition.route() : initialized, id = randomBytes(16).toString('hex');
      await transition.beginExternal(writer, id, [`fs/users/${uid}`, `inventory/${uid}`, `verification/${provider}/${uid}`, accountResource(uid)]);
      try { return await request.run({ writer, id }, action); }
      finally { await transition.endExternal(id); }
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
      return { membership: saved.membership, version: saved.version, stored: saved.stored };
    },
  };
}
module.exports = { createMembershipWriterRepository };
