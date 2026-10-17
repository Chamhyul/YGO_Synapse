'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomBytes } = require('node:crypto');
const { sessionValue, checkHash, IDLE_MS } = require('./user-storage/adminSessionStore');
const { accountResource } = require('./user-storage/accountResource');
const fail = code => Object.assign(new Error('관리자 세션의 전환 상태를 확인하고 다시 로그인해 주세요.'), { code });
const id = () => randomBytes(16).toString('hex');
function createSessionWriterRepository({ transition, adapters, initialize, timeoutMs = 10000 }) {
  const observations = new WeakMap(), requests = new AsyncLocalStorage();
  const keyFor = hash => { checkHash(hash); return `session/${hash}`; };
  const resources = (key, uid) => [key, ...(uid ? [accountResource(uid)] : [])];
  async function lease(locks) {
    const request = requests.getStore(); if (!request) return;
    const candidate = request.id || id(), deadline = Date.now() + timeoutMs;
    while (true) {
      try {
        if (!request.id) await transition.beginExternal(request.writer, candidate, [`sessionRequest/${candidate}`, ...locks]);
        else await transition.addExternalResources(request.id, locks);
        request.id = candidate; return;
      } catch (error) {
        if (error.code !== 'WRITER_RESOURCE_BUSY' || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
  }
  async function selected() { await initialize(); return requests.getStore()?.writer || transition.route(); }
  async function read(hash) {
    const key = keyFor(hash);
    for (let i = 0; i < 3; i++) {
      const writer = await selected(), current = await adapters[writer.backend].inspect(key), after = await transition.route();
      if (writer.backend !== after.backend || writer.epoch !== after.epoch) {
        if (requests.getStore()) throw fail('WRITER_FENCED'); continue;
      }
      if (current.entry.exists) await lease(resources(key, current.entry.value.uid));
      return { writer, current };
    }
    throw fail('WRITER_FENCED');
  }
  async function publish(writer, entry, action, result, extra = {}) {
    const locks = resources(entry.key, entry.value?.uid || extra.uid); await lease(locks);
    const operationId = id(); let op; const expires = Date.now() + timeoutMs;
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
  return {
    writerLease: () => requests.getStore(),
    async withRequest(req, action) {
      const writer = await selected();
      const context = { writer };
      try { return await requests.run(context, action); }
      finally { if (context.id) await transition.endExternal(context.id); }
    },
    async beginLogin(uid, oldHash) {
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
      const value = current.entry.value; observations.set(value, { key: keyFor(hash), writer, token: current.entry.token }); return value;
    },
    async set(hash, value) {
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
      keyFor(hash);
      if (typeof uid !== 'string' || !uid || uid.length > 128 || Buffer.from(uid).toString() !== uid) return false;
      if (!Number.isSafeInteger(at) || at < 0) throw fail('USER_STORAGE_INVALID_SESSION_TIME');
      const writer = await selected(), key = keyFor(hash); let generation;
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
