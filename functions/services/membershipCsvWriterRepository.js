'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { measure } = require('./inventoryRequestTiming');
const { randomBytes } = require('node:crypto');
const { createMembershipCsvStore } = require('./user-storage/membershipCsvStore');
const C = require('./membershipCsvWriterContract');
const { fingerprint } = require('./userMigrationRehearsal');
const { encodeValue, decodeValue } = require('./user-storage/codec');
const id = () => randomBytes(16).toString('hex');
function createCsvWriterRepository({ transition, adapters, initialize, initializeMissing = true, now = Date.now, parentLease = () => undefined, timeoutMs = 10000 }) {
  const requests = new AsyncLocalStorage(), actions = new AsyncLocalStorage();
  let store;
  const readMethods = new Set(['read', 'readMember', 'status']);
  const view = entry => fingerprint({ exists: entry.exists, token: entry.token, value: entry.value });
  const activeView = entry => fingerprint({ exists: entry.exists, active: entry.value?.active, baseRevision: entry.value?.baseRevision });
  async function wait(work) {
    const deadline = Date.now() + timeoutMs;
    while (true) { try { return await work(); } catch (error) { if (error.code !== 'WRITER_RESOURCE_BUSY' || Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve,20)); } }
  }
  async function withRequest(req, action) {
    if (requests.getStore()) return action();
    const parent = parentLease(), initialized = parent?.writer || await initialize();
    const writer = parent?.writer || (initializeMissing ? await transition.route() : initialized);
    const context = { writer, id: parent?.id || id(), own: !parent?.id, resources: new Set(['csv/control']) };
    if (context.own) await wait(() => transition.beginExternal(writer,context.id,[`csvRequest/${context.id}`,'csv/control']));
    else await wait(() => transition.addExternalResources(context.id,['csv/control']));
    try { return await requests.run(context,action); }
    finally { if (context.own) await transition.endExternal(context.id); }
  }
  const keyFor = (kind, value) => { const key = kind === 'control' ? 'csv/control' : `csv/${kind}/${value}`; C.checkCsvKey(key); return key; };
  async function inspect(key) {
    const context=requests.getStore(); if(!context || context.unresolved)throw C.fail('WRITER_OUTCOME_UNRESOLVED');
    if (context.readOnly && key === 'csv/control') return context.control;
    return adapters[context.writer.backend].inspect(key);
  }
  const record = current => ({ exists:current.entry.exists, revision:current.revision,generation:current.generation,value:current.entry.value });
  async function publish(key, observed, value, result) {
    const context=requests.getStore(), action=actions.getStore();
    if (context?.readOnly) throw C.fail('CSV_WRITER_READ_ONLY');
    if(!action || context.unresolved)throw C.fail('WRITER_OUTCOME_UNRESOLVED');
    if (!context.resources.has(key)) {
      await wait(() => transition.addExternalResources(context.id,[key]));
      context.resources.add(key);
    }
    const control=key==='csv/control'?observed:await inspect('csv/control'), operationId=id();
    const op=await transition.prepare(context.writer,operationId,[{key,exists:true,token:observed.entry.token,value}],result??null,{resources:['csv/control'],
      details:{kind:'membershipCsv',action:action.method,businessId:action.id,controlToken:control.entry.token},parentExternal:context.id});
    try { await transition.execute(context.writer,operationId); }
    catch(error){
      if(error.code!=='WRITER_CANCELLED'){context.unresolved=true;throw error;}
      const reason=await adapters[context.writer.backend].cancellationReason(op);
      if(reason==='conflict')throw Object.assign(C.fail('USER_STORAGE_CONFLICT'),{status:409});
      if(reason==='inactive')throw Object.assign(C.fail('MEMBERSHIP_CSV_CONFLICT'),{status:409});
      throw error;
    }
    return record(await inspect(key));
  }
  function records(kind) {
    return { read:async value=>record(await inspect(keyFor(kind,value))),
      async compareAndSet(value, revision, candidate){const key=keyFor(kind,value),current=await inspect(key);
        if(current.revision!==revision || revision===0&&current.entry.exists)throw C.fail('USER_STORAGE_CONFLICT');return publish(key,current,candidate,null);},
      async update(value,mutate){const key=keyFor(kind,value);
        for(let attempt=0;attempt<3;attempt++){const current=await inspect(key),change=await mutate(decodeValue(encodeValue(current.entry.value)));
          if(kind==='control') for(const [operationId,item] of Object.entries(change.value.operations)) {
            if(current.entry.value.operations[operationId])continue;
            const archiveKey=`csv/operation/${operationId}`,previous=await inspect(archiveKey);
            if(!previous.entry.exists)continue;
            if(previous.entry.value.status!=='pending' || item.status!=='failed' || fingerprint({...previous.entry.value,status:'failed'})!==fingerprint(item))throw C.fail('CSV_WRITER_MIGRATION_REQUIRED');
            await publish(archiveKey,previous,item,null);delete change.value.operations[operationId];
          }
          if(fingerprint(current.entry.value)===fingerprint(change.value))return{record:record(current),result:change.result};
          try{return{record:await publish(key,current,change.value,change.result),result:change.result};}catch(error){if(error.code!=='USER_STORAGE_CONFLICT'||attempt===2)throw error;}}
      },
    };
  }
  store=createMembershipCsvStore({now,records:{control:records('control'),candidates:records('candidate'),operations:records('operation'),
    validateControl:C.controlValue,validateCandidate:C.candidateValue,validateOperation:C.operationValue,revisionOf:C.revisionOf}});
  async function withRead(action, activeOnly = false) {
    if (requests.getStore()) return action();
    const parent = parentLease();
    for (let attempt = 0; attempt < 3; attempt++) {
      const initialized = await initialize();
      const writer = initializeMissing ? await transition.route() : initialized;
      if (parent && (parent.writer.backend !== writer.backend || parent.writer.epoch !== writer.epoch)) throw C.fail('WRITER_FENCED');
      if (!parent && writer.phase !== 'accepting' || parent && !['accepting', 'draining'].includes(writer.phase)) throw C.fail('WRITER_DRAINING');
      const adapter = adapters[writer.backend], control = await adapter.inspect('csv/control');
      const context = { writer, readOnly: true, control };
      const result = await requests.run(context, action);
      const [after, route] = await Promise.all([adapter.inspect('csv/control'), transition.route()]);
      const signature = activeOnly ? activeView : view;
      if (writer.backend === route.backend && writer.epoch === route.epoch && writer.phase === route.phase
          && signature(control.entry) === signature(after.entry)) return result;
    }
    throw C.fail('CSV_WRITER_READ_CONFLICT');
  }
  const lookupMember = channelId => withRead(async () => {
    const context = requests.getStore(), control = context.control || await adapters[context.writer.backend].inspect('csv/control');
    C.controlValue(control.entry.value);
    const pointer = control.entry.value.active;
    let member = null;
    if (pointer) {
      const adapter = adapters[context.writer.backend];
      member = adapter.lookupMember ? await adapter.lookupMember(pointer, channelId)
        : await store.readMember(channelId);
    }
    return { member: member ? { channelId: member.channelId, levelName: member.levelName } : null,
      writer: context.writer, signature: activeView(control.entry) };
  }, true);
  return { withRequest, withReadRequest: (_req, action) => withRead(action),
    async prepareActiveLookup({ revision, fingerprint: expectedFingerprint, dryRun = true } = {}) {
      const action = async () => {
        const context = requests.getStore(), adapter = adapters[context.writer.backend];
        if (context.writer.backend !== 'rtdb' || !adapter.lookupPlan || !adapter.prepareLookup) throw C.fail('CSV_WRITER_LOOKUP_UNAVAILABLE');
        const control = context.control || await adapter.inspect('csv/control');
        C.controlValue(control.entry.value);
        const pointer = control.entry.value.active;
        if (!pointer) return { count: 0, noIndexRequired: true };
        if ((!dryRun || revision !== undefined) && (revision !== pointer.revision || expectedFingerprint !== pointer.fingerprint)) throw C.fail('MEMBERSHIP_CSV_CONFLICT');
        const plan = await adapter.lookupPlan(pointer.revision);
        if (plan.fingerprint !== pointer.fingerprint || plan.count !== pointer.count) throw C.fail('CSV_WRITER_LOOKUP_INVALID');
        if (!dryRun) await adapter.prepareLookup(pointer.revision);
        return { revision: pointer.revision, fingerprint: pointer.fingerprint, count: plan.count, indexBytes: plan.indexBytes,
          dryRun, sourceUnchanged: true };
      };
      return dryRun ? withRead(action, true) : withRequest(null, action);
    },
    readMemberSummary: async channelId => (await lookupMember(channelId)).member,
    async withMember(channelId, action) {
      let observed = await measure('youtube.csv', () => lookupMember(channelId));
      const parent = parentLease();
      if (!parent) throw C.fail('CSV_WRITER_REQUEST_REQUIRED');
      // 조회에서는 쓰지 않는다. 실제 멤버십 저장 직전에만 목록 버전을 고정한다.
      let refreshAccount = false;
      await measure('csv.pin', () => wait(async () => {
        try { return await transition.addExternalResources(parent.id, ['csv/control']); }
        catch (error) { if (error.code === 'WRITER_RESOURCE_BUSY') refreshAccount = true; throw error; }
      }));
      const latest = await adapters[parent.writer.backend].inspect('csv/control');
      if (observed.writer.backend !== parent.writer.backend || observed.writer.epoch !== parent.writer.epoch) throw C.fail('WRITER_FENCED');
      if (activeView(latest.entry) !== observed.signature) { observed = await lookupMember(channelId); refreshAccount = true; }
      return action(observed.member, { refreshAccount });
    },
    ...Object.fromEntries(['read','readMember','status','begin','stage','commit','fail','expire'].map(method => [method, (...args) => {
      const action = () => actions.run({ method, id: args[0] }, async () => {
        const result = await store[method](...args);
        if (method === 'stage') await adapters[requests.getStore().writer.backend].prepareLookup?.(args[0]);
        return result;
      });
      return readMethods.has(method) ? withRead(action) : withRequest(null, action);
    }])) };
}
module.exports={createCsvWriterRepository};
