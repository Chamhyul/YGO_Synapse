'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomBytes } = require('node:crypto');
const { createMembershipCsvStore } = require('./user-storage/membershipCsvStore');
const C = require('./membershipCsvWriterContract');
const { fingerprint } = require('./userMigrationRehearsal');
const { encodeValue, decodeValue } = require('./user-storage/codec');
const id = () => randomBytes(16).toString('hex');
function createCsvWriterRepository({ transition, adapters, initialize, now = Date.now, parentLease = () => undefined, timeoutMs = 10000 }) {
  const requests = new AsyncLocalStorage(), actions = new AsyncLocalStorage();
  let store;
  async function wait(work) {
    const deadline = Date.now() + timeoutMs;
    while (true) { try { return await work(); } catch (error) { if (error.code !== 'WRITER_RESOURCE_BUSY' || Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve,20)); } }
  }
  async function withRequest(req, action) {
    if (requests.getStore()) return action();
    await initialize(); const parent = parentLease(), writer = parent?.writer || await transition.route();
    const context = { writer, id: parent?.id || id(), own: !parent?.id };
    if (context.own) await wait(() => transition.beginExternal(writer,context.id,[`csvRequest/${context.id}`,'csv/control']));
    else await wait(() => transition.addExternalResources(context.id,['csv/control']));
    try { return await requests.run(context,action); }
    finally { if (context.own) await transition.endExternal(context.id); }
  }
  const keyFor = (kind, value) => { const key = kind === 'control' ? 'csv/control' : `csv/${kind}/${value}`; C.checkCsvKey(key); return key; };
  async function inspect(key) {
    const context=requests.getStore(); if(!context || context.unresolved)throw C.fail('WRITER_OUTCOME_UNRESOLVED');
    return adapters[context.writer.backend].inspect(key);
  }
  const record = current => ({ exists:current.entry.exists, revision:current.revision,generation:current.generation,value:current.entry.value });
  async function publish(key, observed, value, result) {
    const context=requests.getStore(), action=actions.getStore();
    if(!action || context.unresolved)throw C.fail('WRITER_OUTCOME_UNRESOLVED');
    await wait(() => transition.addExternalResources(context.id,[key]));
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
  return {withRequest,...Object.fromEntries(['read','readMember','status','begin','stage','commit','fail','expire'].map(method=>[method,(...args)=>withRequest(null,()=>actions.run({method,id:args[0]},()=>store[method](...args)))]))};
}
module.exports={createCsvWriterRepository};
