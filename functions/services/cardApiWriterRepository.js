'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomBytes } = require('node:crypto');
const { parseToken, verifyRecord, keyOptions, validOrigin, failure } = require('./cardApiAccess');
const { checkApiKey, consumeValue } = require('./cardApiWriterContract');
const id = () => randomBytes(16).toString('hex');
function createApiWriterRepository({ transition, adapters, initialize, initializeMissing = true, clock = Date.now, timeoutMs = 10000 }) {
  const requests = new AsyncLocalStorage();
  const keyFor = value => { if (typeof value !== 'string' || !/^[a-f0-9]{24}$/.test(value)) throw failure(400, 'INVALID_KEY_ID'); const key = `apiKey/${value}`; checkApiKey(key); return key; };
  const now = () => { const at = clock(); if (!Number.isSafeInteger(at) || at < 0) throw failure(503, 'API_UNAVAILABLE'); return at; };
  async function lease(locks) {
    const request = requests.getStore();
    const task = (request.leaseTail || Promise.resolve()).then(() => acquire(request, locks));
    request.leaseTail = task.catch(() => {}); return task;
  }
  async function acquire(request, locks) {
    const missing = locks.filter(key => !request.resources.has(key));
    if (request.id && !missing.length) return;
    const deadline = Date.now() + timeoutMs, candidate = request.id || id();
    while (true) {
      try {
        if (request.id) await transition.addExternalResources(request.id, missing);
        else await transition.beginExternal(request.writer, candidate, [`apiRequest/${candidate}`, ...locks]);
        request.id = candidate;
        for (const key of locks) request.resources.add(key);
        return;
      } catch (error) { if (error.code !== 'WRITER_RESOURCE_BUSY' || Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
    }
  }
  async function withRequest(req, action) {
    if (requests.getStore()) return action();
    const initialized = await initialize();
    const context = { writer: initializeMissing ? await transition.route() : initialized, resources: new Set() };
    try { return await requests.run(context, action); }
    finally { if (context.id) await transition.endExternal(context.id); }
  }
  async function publish(entry, action, result, extra = {}) {
    const request = requests.getStore(), opId = id();
    const options = {
      resources: [entry.key, ...(['register', 'disable'].includes(action) ? ['apiCors/current'] : [])],
      details: { kind: 'apiAccess', action, ...extra }, parentExternal: request.id,
    };
    let op;
    try {
      if (typeof transition.prepareAndExecuteWithReceipt === 'function') {
        const completed = await transition.prepareAndExecuteWithReceipt(request.writer, opId, [entry], result,
          { ...options, onPrepared: value => { op = value; } });
        return { result: completed.result };
      }
      op = await transition.prepare(request.writer, opId, [entry], result, options);
      return { result: await transition.execute(request.writer, opId) };
    }
    catch (error) {
      if (error.code !== 'WRITER_CANCELLED' || !op) throw error;
      return { cancelled: await adapters[request.writer.backend].cancellationReason(op) || 'fenced' };
    }
  }
  async function mutate(key, action, work, extra = {}) {
    return withRequest(null, async () => {
      await lease([key, ...(['register', 'disable'].includes(action) ? ['apiCors/current'] : [])]);
      const adapter = adapters[requests.getStore().writer.backend];
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await adapter.inspect(key), candidate = work(current, now());
        const outcome = await publish({ key, exists: true, token: current.entry.token, value: candidate.value }, action, candidate.result ?? null, extra);
        if (!outcome.cancelled) return outcome.result;
        if (!['conflict', 'inactive'].includes(outcome.cancelled)) throw Object.assign(failure(503, 'API_UNAVAILABLE'), { code: 'WRITER_CANCELLED' });
      }
      throw failure(503, 'API_UNAVAILABLE');
    });
  }
  function stableKey(key) {
    keyFor(key?.id); if (!/^[a-f0-9]{64}$/.test(key?.secretHash || '')) throw failure(400, 'INVALID_KEY_ID');
    return { id: key.id, secretHash: key.secretHash }; // token 원문은 변경 기록에 넣지 않는다.
  }
  return {
    withRequest,
    authenticate: token => withRequest(null, async () => {
      const parsed = parseToken(token), key = keyFor(parsed.id); await lease([key]);
      const record = await adapters[requests.getStore().writer.backend].read(key);
      return { id: parsed.id, ...verifyRecord(record.value?.policy, parsed, now()) };
    }),
    allowsPreflight: origin => withRequest(null, async () => {
      if (!validOrigin(origin)) return false;
      await lease(['apiCors/current']); return adapters[requests.getStore().writer.backend].allowsPreflight(origin);
    }),
    consume(token, origin) {
      const parsed = parseToken(token);
      return mutate(keyFor(parsed.id), 'consume', current => {
        if (origin !== undefined && !validOrigin(origin)) { verifyRecord(current.entry.value?.policy, parsed, now()); throw failure(403, 'ORIGIN_NOT_ALLOWED'); }
        return consumeValue(current.entry.value, parsed, origin ?? null, now());
      },
        { secretHash: parsed.secretHash, origin: origin ?? null });
    },
    register(key, options) {
      const stable = stableKey(key), policy = keyOptions(options);
      return mutate(keyFor(stable.id), 'register', (current, at) => {
        if (current.revision || current.entry.exists) throw failure(409, 'KEY_ALREADY_EXISTS');
        return { value: { policy: { ...policy, secretHash: stable.secretHash, createdAt: at }, usage: null, corsOrigins: policy.origins } };
      });
    },
    disable(keyId) {
      return mutate(keyFor(keyId), 'disable', (current, at) => {
        if (!current.entry.exists) throw failure(404, 'KEY_NOT_FOUND');
        return { value: { ...current.entry.value, policy: { ...current.entry.value.policy, enabled: false, disabledAt: at }, corsOrigins: null } };
      });
    },
    rotate(key) {
      const stable = stableKey(key);
      return mutate(keyFor(stable.id), 'rotate', (current, at) => {
        if (!current.entry.exists) throw failure(404, 'KEY_NOT_FOUND');
        const { policy } = current.entry.value;
        if (!policy.enabled || policy.expiresAt !== null && policy.expiresAt <= at) throw failure(403, 'API_KEY_DISABLED');
        return { value: { ...current.entry.value, policy: { ...policy, secretHash: stable.secretHash, rotatedAt: at } } };
      });
    },
  };
}
module.exports = { createApiWriterRepository };
