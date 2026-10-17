'use strict';
const { encodeKey, decodeKey, encodeValue, decodeValue } = require('./user-storage/codec');
const { validateVerificationState, validateMembership } = require('./user-storage/membershipStore');
const { decodeRecord } = require('./user-storage/recordStore');
const { createStorageAccess } = require('./user-storage/storageAccess');
const { checkProfileKey } = require('./userProfileWriterAdapters');
const { content, fingerprint } = require('./userMigrationRehearsal');
const clone = value => decodeValue(encodeValue(value));
const fail = code => Object.assign(new Error('멤버십 인증의 저장 영수증과 전환 상태를 확인해 주세요.'), { code });
const absent = key => ({ key, exists: false, token: '0' });
function checkVerificationKey(key) {
  const match = typeof key === 'string' && /^verification\/(discord|youtube)\/(.+)$/.exec(key);
  if (!match) throw fail('MEMBERSHIP_WRITER_INVALID_KEY');
  checkProfileKey(`fs/users/${match[2]}`); return { provider: match[1], uid: match[2] };
}
function verificationValue(value, provider) {
  return validateVerificationState({ ...value, completed: value.completed ?? false,
    profileGeneration: value.profileGeneration ?? 0 }, provider);
}
function command(op) {
  if (op.details?.kind !== 'membership' || !['start', 'consume', 'complete'].includes(op.details.action)
      || op.changes.length < 1 || op.changes.length > 2) throw fail('MEMBERSHIP_WRITER_INVALID_COMMAND');
  const nonce = op.changes.find(entry => entry.key.startsWith('verification/'));
  if (!nonce?.exists) throw fail('MEMBERSHIP_WRITER_INVALID_COMMAND');
  const { uid, provider } = checkVerificationKey(nonce.key);
  verificationValue(nonce.value, provider);
  const profile = op.changes.find(entry => entry.key === `fs/users/${uid}`);
  if (op.changes.length !== 1 + Number(!!profile) || profile && (!profile.exists || op.details.action !== 'complete')
      || typeof op.details.profileToken !== 'string' || profile && profile.token !== op.details.profileToken) throw fail('MEMBERSHIP_WRITER_INVALID_COMMAND');
  return { uid, provider, nonce, profile };
}
function receipt(raw, id, digest) {
  if (!raw || raw.id !== id || raw.digest !== digest || !['write', 'projection', 'cancelled'].includes(raw.kind)) throw fail('MEMBERSHIP_WRITER_RECEIPT_CONFLICT');
  if (raw.kind === 'cancelled') return { id, digest, outcome: 'cancelled' };
  return { id, digest, changes: decodeValue(raw.changes), result: decodeValue(raw.result) };
}
function proof(id, digest, kind, changes, result = null) {
  return { id, digest, kind, ...(changes ? { changes: encodeValue(changes), result: encodeValue(result) } : {}) };
}
function createMembershipWriterAdapters({ db, database, FieldValue, profiles, timeoutMs, onAmbiguousWrite }) {
  const access = createStorageAccess({ database, timeoutMs, onAmbiguousWrite });
  const adapters = {};
  for (const backend of ['legacy', 'rtdb']) {
    const native = profiles[backend].membershipStorage;
    const fsRefs = key => { const { uid, provider } = checkVerificationKey(key); return {
      body: db.collection(`${provider}_membership_verifications`).doc(uid),
      meta: db.collection('membershipWriterMetadata').doc(encodeKey(key)),
    }; };
    function observed(key, value, marker, updateTime) {
      const { provider } = checkVerificationKey(key);
      const exists = value != null;
      const entry = { key, exists, token: '0', ...(exists ? { value: verificationValue(value, provider) } : {}) };
      if (marker != null) {
        if (marker.format !== 1 || !Number.isSafeInteger(marker.revision) || marker.revision < 1
            || typeof marker.exists !== 'boolean' || !/^[a-f0-9]{64}$/.test(marker.digest)) throw fail('MEMBERSHIP_WRITER_INVALID_METADATA');
        if (marker.exists === exists && marker.digest === content(entry)) entry.token = `n:${marker.revision}`;
        else if (!exists || backend === 'rtdb') throw fail('MEMBERSHIP_WRITER_UNTRACKED_CHANGE');
      }
      if (exists && entry.token === '0') entry.token = backend === 'legacy'
        ? `u:${updateTime.seconds}:${updateTime.nanoseconds}` : `u:${fingerprint(entry.value)}`;
      return entry;
    }
    const location = key => { const { uid, provider } = checkVerificationKey(key);
      return { ...native.location(`fs/users/${uid}`), provider }; };
    async function read(key) {
      if (backend === 'legacy') {
        const refs = fsRefs(key);
        return access.guarded(db.runTransaction(async tx => {
          const body = await tx.get(refs.body), meta = await tx.get(refs.meta);
          return observed(key, body.exists ? body.data() : null, meta.data(), body.updateTime);
        }), false);
      }
      const loc = location(key), raw = (await access.guarded(loc.parent.get(), false)).val() || {};
      return observed(key, raw.verification?.[loc.provider], raw.verificationWriterMetadata?.[loc.provider]);
    }
    async function context(uid, provider) {
      const profileKey = `fs/users/${uid}`, key = `verification/${provider}/${uid}`; checkVerificationKey(key);
      if (backend === 'legacy') {
        const refs = fsRefs(key), user = native.refs(profileKey);
        return access.guarded(db.runTransaction(async tx => {
          const body = await tx.get(refs.body), meta = await tx.get(refs.meta), profile = await tx.get(user.user), marker = await tx.get(user.meta);
          return { nonce: observed(key, body.exists ? body.data() : null, meta.data(), body.updateTime),
            profile: native.observed(profileKey, profile, marker), generation: 0, tombstone: marker.data()?.exists === false };
        }), false);
      }
      const loc = location(key), raw = (await access.guarded(loc.parent.get(), false)).val() || {};
      const record = decodeRecord(raw.profile, { path: loc.profile, payloadCodec: native.codec });
      return { nonce: observed(key, raw.verification?.[provider], raw.verificationWriterMetadata?.[provider]),
        profile: native.decode(profileKey, raw.profile), generation: record.generation, tombstone: !!raw.profile?.tombstone };
    }
    function precondition(op, current, profile, generation, tombstone) {
      if (current.token !== op.changes.find(entry => entry.key === current.key).token
          || profile.token !== op.details.profileToken) return 'conflict';
      const state = current.value, candidate = op.changes.find(entry => entry.key === current.key).value;
      if (op.details.action === 'start') {
        if (candidate.consumed || candidate.completed || candidate.profileGeneration !== generation) throw fail('MEMBERSHIP_WRITER_INVALID_COMMAND');
        if (state && candidate.startedAt - state.startedAt < 3000) throw fail('MEMBERSHIP_TOO_MANY_REQUESTS');
        return undefined;
      }
      if (!state || state.nonceHash !== candidate.nonceHash || state.completed || state.expiresAt <= Date.now()
          || state.profileGeneration !== generation || tombstone && op.details.action === 'complete' && !state.localOnly
          || state.consumed !== (op.details.action === 'complete')) return 'expired';
      const expected = { ...state, consumed: true, completed: op.details.action === 'complete' };
      if (fingerprint(candidate) !== fingerprint(expected)) throw fail('MEMBERSHIP_WRITER_INVALID_COMMAND');
      if (op.details.action === 'complete') {
        const planned = command(op).profile;
        if (!!planned !== !state.localOnly) throw fail('MEMBERSHIP_WRITER_INVALID_COMMAND');
        if (planned) {
          const membership = validateMembership(planned.value?.settings?.membership, checkVerificationKey(current.key).provider);
          const value = profile.value ?? {};
          if (fingerprint(planned.value) !== fingerprint({ ...value, settings: { ...value.settings, membership } })) throw fail('MEMBERSHIP_WRITER_INVALID_COMMAND');
        }
      }
      return undefined;
    }
    async function transact(key, id, digest, change, expected, op, fenced = false) {
      access.ensureUsable();
      const kind = fenced ? 'cancelled' : op ? 'write' : 'projection';
      if (backend === 'legacy') {
        const refs = fsRefs(key), receiptRef = db.collection('membershipWriterReceipts').doc(id);
        await access.guarded(db.runTransaction(async tx => {
          access.ensureUsable();
          const prior = await tx.get(receiptRef); if (prior.exists) { receipt(prior.data(), id, digest); return; }
          if (fenced) { tx.create(receiptRef, { ...proof(id, digest, kind), reason: 'fenced' }); return; }
          const body = await tx.get(refs.body), meta = await tx.get(refs.meta);
          const current = observed(key, body.exists ? body.data() : null, meta.data(), body.updateTime);
          let profile, user, marker, reason;
          if (op) {
            const cmd = command(op); user = native.refs(`fs/users/${cmd.uid}`);
            const document = await tx.get(user.user); marker = await tx.get(user.meta);
            profile = native.observed(`fs/users/${cmd.uid}`, document, marker);
            reason = precondition(op, current, profile, 0, marker.data()?.exists === false);
          } else if (current.token !== expected.token || content(current) !== content(expected)) throw fail('MEMBERSHIP_WRITER_TARGET_CONFLICT');
          if (reason) { tx.create(receiptRef, { ...proof(id, digest, 'cancelled'), reason }); return; }
          const revision = (meta.data()?.revision || 0) + 1;
          if (!Number.isSafeInteger(revision)) throw fail('USER_STORAGE_REVISION_EXHAUSTED');
          if (change.exists) tx.set(refs.body, change.value); else tx.delete(refs.body);
          tx.set(refs.meta, { format: 1, revision, exists: change.exists, digest: content(change) });
          const entries = [{ ...change, token: `n:${revision}` }];
          const profileChange = op && command(op).profile;
          if (profileChange) {
            const profileRevision = (marker.data()?.revision || 0) + 1;
            if (!Number.isSafeInteger(profileRevision)) throw fail('USER_STORAGE_REVISION_EXHAUSTED');
            tx.set(user.user, profileChange.value);
            tx.set(user.meta, { format: 1, revision: profileRevision, exists: true, digest: content(profileChange), serverTimestampPaths: encodeValue([]), at: FieldValue.serverTimestamp() });
            entries.push({ ...profileChange, token: `m:${profileRevision}` });
          }
          tx.create(receiptRef, proof(id, digest, kind, entries, op?.result ?? null));
        }), true);
        return (await access.guarded(receiptRef.get(), false)).data();
      }
      const loc = location(key); let listener, callbackError;
      try {
        await access.guarded(new Promise((resolve, reject) => { listener = resolve; loc.parent.on('value', listener, reject); }), false);
        const result = await access.guarded(loc.parent.transaction(raw => {
          callbackError = undefined;
          try {
            access.ensureUsable(); raw ||= {}; raw.membershipWriterReceipts ||= {};
            if (raw.membershipWriterReceipts[id]) { receipt(raw.membershipWriterReceipts[id], id, digest); return raw; }
            if (fenced) { raw.membershipWriterReceipts[id] = { ...proof(id, digest, kind), reason: 'fenced' }; return raw; }
            const current = observed(key, raw.verification?.[loc.provider], raw.verificationWriterMetadata?.[loc.provider]);
            let reason;
            const profileKey = `fs/users/${checkVerificationKey(key).uid}`;
            const profileRecord = decodeRecord(raw.profile, { path: loc.profile, payloadCodec: native.codec });
            if (op) reason = precondition(op, current, native.decode(profileKey, raw.profile), profileRecord.generation, !!raw.profile?.tombstone);
            else if (current.token !== expected.token || content(current) !== content(expected)) throw fail('MEMBERSHIP_WRITER_TARGET_CONFLICT');
            if (reason) { raw.membershipWriterReceipts[id] = { ...proof(id, digest, 'cancelled'), reason }; return raw; }
            const revision = (raw.verificationWriterMetadata?.[loc.provider]?.revision || 0) + 1;
            if (!Number.isSafeInteger(revision)) throw fail('USER_STORAGE_REVISION_EXHAUSTED');
            raw.verification ||= {}; raw.verificationWriterMetadata ||= {};
            if (change.exists) raw.verification[loc.provider] = clone(change.value); else delete raw.verification[loc.provider];
            raw.verificationWriterMetadata[loc.provider] = { format: 1, revision, exists: change.exists, digest: content(change) };
            const entries = [{ ...change, token: `n:${revision}` }], profileChange = op && command(op).profile;
            if (profileChange) {
              const next = { format: 1, revision: profileRecord.revision + 1, generation: profileRecord.generation, tombstone: false,
                payload: native.codec.encode(profileChange.value, { basePath: `${loc.profile}/payload` }) };
              if (!Number.isSafeInteger(next.revision)) throw fail('USER_STORAGE_REVISION_EXHAUSTED');
              raw.profile = next; entries.push(native.decode(profileKey, next));
            }
            raw.membershipWriterReceipts[id] = proof(id, digest, kind, entries, op?.result ?? null); return raw;
          } catch (error) { callbackError = error; return undefined; }
        }, undefined, false), true);
        if (callbackError) throw callbackError;
        if (!result.committed) throw fail('MEMBERSHIP_WRITER_TARGET_CONFLICT');
        return result.snapshot.val().membershipWriterReceipts[id];
      } finally { if (listener) loc.parent.off('value', listener); }
    }
    async function rawReceipt(op) {
      if (backend === 'legacy') return (await access.guarded(db.collection('membershipWriterReceipts').doc(op.id).get(), false)).data();
      const { nonce } = command(op), loc = location(nonce.key);
      return (await access.guarded(loc.parent.child(`membershipWriterReceipts/${op.id}`).get(), false)).val();
    }
    adapters[backend] = { read, context,
      async snapshot() {
        const entries = [];
        if (backend === 'legacy') {
          for (const provider of ['discord', 'youtube']) {
            let last;
            while (true) {
              let query = db.collection(`${provider}_membership_verifications`).orderBy('__name__').limit(25);
              if (last) query = query.startAfter(last);
              const page = await access.guarded(query.get(), false);
              for (const doc of page.docs) entries.push(await read(`verification/${provider}/${doc.id}`));
              if (page.size < 25) break; last = page.docs.at(-1);
            }
          }
          // 논리 삭제의 token도 대상 예상 상태에 포함한다.
          const markers = await access.guarded(db.collection('membershipWriterMetadata').get(), false);
          for (const doc of markers.docs) { const key = decodeKey(doc.id); if (!entries.some(entry => entry.key === key)) entries.push(await read(key)); }
        } else {
          let last;
          while (true) {
            let query = database.ref('users').orderByKey().limitToFirst(25); if (last) query = query.startAfter(last);
            const page = await access.guarded(query.get(), false); let count = 0;
            page.forEach(child => { count++; last = child.key; const raw = child.val();
              for (const provider of new Set([...Object.keys(raw.verification || {}), ...Object.keys(raw.verificationWriterMetadata || {})])) {
                entries.push(observed(`verification/${provider}/${decodeKey(child.key)}`, raw.verification?.[provider], raw.verificationWriterMetadata?.[provider]));
              }
            }); if (count < 25) break;
          }
        }
        if (entries.some(entry => entry.exists && entry.value.profileGeneration !== 0)) throw fail('MEMBERSHIP_WRITER_GENERATION_MIGRATION_REQUIRED');
        return entries.sort((a, b) => a.key.localeCompare(b.key));
      },
      async commit(op) { const { nonce } = command(op); await transact(nonce.key, op.id, op.digest, nonce, null, op); },
      async receipt(op) { const raw = await rawReceipt(op); return raw ? receipt(raw, op.id, op.digest) : null; },
      async cancellationReason(op) { const raw = await rawReceipt(op); if (raw) receipt(raw, op.id, op.digest); return raw?.reason; },
      async fence(op) { const { nonce } = command(op); await transact(nonce.key, op.id, op.digest, nonce, null, op, true); return this.receipt(op); },
      async apply(id, entry, expected) {
        checkVerificationKey(entry.key); if (entry.exists) verificationValue(entry.value, checkVerificationKey(entry.key).provider);
        const digest = fingerprint({ entry, expected }), raw = await transact(entry.key, id, digest, entry, expected);
        if (raw.kind !== 'projection') throw fail('MEMBERSHIP_WRITER_RECEIPT_CONFLICT');
        return receipt(raw, id, digest).changes[0];
      },
    };
  }
  return adapters;
}
module.exports = { createMembershipWriterAdapters, checkVerificationKey, checkMembershipCommand: command };
