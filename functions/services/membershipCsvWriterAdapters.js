'use strict';
const { encodeKey, decodeKey, encodeValue, decodeValue } = require('./user-storage/codec');
const { createRecordStore, checkCommitReceipt } = require('./user-storage/recordStore');
const { createStorageAccess } = require('./user-storage/storageAccess');
const { content, fingerprint } = require('./userMigrationRehearsal');
const C = require('./membershipCsvWriterContract');
const clone = value => decodeValue(encodeValue(value));
const absent = key => ({ key, exists: false, token: '0' });
function createCsvWriterAdapters({ db, database, now = Date.now, timeoutMs = 10000, onAmbiguousWrite }) {
  const access = createStorageAccess({ database, timeoutMs, onAmbiguousWrite });
  const legacy = (() => {
    const heads = db.collection('membershipCsvWriterRecords'), receipts = db.collection('membershipCsvWriterReceipts');
    const imports = db.collection('membership_csv_imports'), current = db.collection('membership_csv_state').doc('current');
    const oldUsers = db.collection('membership_csv_users'), payloads = db.collection('membershipCsvWriterPayloads');
    const get = (tx, ref) => access.guarded(tx ? tx.get(ref) : ref.get(), false);
    async function rows(collection, tx, legacy = false) {
      const docs = (await get(tx, collection.orderBy('__name__'))).docs;
      const members = docs.map(doc => { const raw = doc.data();
        if (raw.channelId !== doc.id) throw C.fail('CSV_WRITER_MIGRATION_REQUIRED'); return raw; });
      members.sort((a, b) => a.channelId.localeCompare(b.channelId));
      // 공개 legacy revision은 기존 Firestore 읽기의 원문 필드 순서로 계산한다.
      return { members: C.membersValue(members, true, legacy), legacyRevision: C.legacyRevision(members), stamp: fingerprint(docs.map(doc => [doc.id, doc.updateTime.seconds, doc.updateTime.nanoseconds])) };
    }
    function stateValue(raw) {
      if (raw && (Object.keys(raw).sort().join(',') !== 'count,revision,updatedAt' || !/^[a-f0-9]{32}$/.test(raw.revision)
          || !Number.isSafeInteger(raw.count) || raw.count < 1 || raw.updatedAt !== null && (!Number.isSafeInteger(raw.updatedAt) || raw.updatedAt < 0))) throw C.fail('CSV_WRITER_MIGRATION_REQUIRED');
      return raw;
    }
    async function bodyFrom(header, key, tx) {
      if (header.payload !== undefined) return C.valueFor(key, decodeValue(header.payload));
      if (!/^[a-f0-9]{32}$/.test(header.blob || '')) throw C.fail('CSV_WRITER_INVALID_METADATA');
      const { kind } = C.checkCsvKey(key);
      const { members } = await rows(payloads.doc(header.blob).collection('members'), tx, kind === 'legacyUsers' || header.legacyList === true);
      const value = kind === 'legacyUsers' ? members : { members, fingerprint: C.digest(members), ...(header.legacyList ? { legacyList: true } : {}) };
      C.valueFor(key, value); if (fingerprint(value) !== header.valueDigest) throw C.fail('CSV_WRITER_UNTRACKED_CHANGE'); return value;
    }
    async function inspect(key, tx) {
      const { kind, id } = C.checkCsvKey(key), snap = await get(tx, heads.doc(encodeKey(key))), header = snap.data();
      if (header) {
        if (header.format !== 1 || !Number.isSafeInteger(header.revision) || header.revision < 1 || !Number.isSafeInteger(header.generation)
            || header.generation < 0 || header.generation > header.revision || typeof header.exists !== 'boolean' || !/^[a-f0-9]{64}$/.test(header.digest)
            || header.ownedOperations !== undefined && (!Array.isArray(header.ownedOperations) || header.ownedOperations.some(id=>!/^[a-f0-9]{32}$/.test(id)) || new Set(header.ownedOperations).size!==header.ownedOperations.length)) throw C.fail('CSV_WRITER_INVALID_METADATA');
        const entry = { key, exists: header.exists, token: `m:${header.revision}:${header.generation}`,
          ...(header.exists ? { value: await bodyFrom(header, key, tx) } : {}) };
        if (content(entry) !== header.digest) throw C.fail('CSV_WRITER_UNTRACKED_CHANGE');
        if (entry.exists && kind === 'control') {
          if (fingerprint((await get(tx, current)).data() ?? null) !== fingerprint(header.physical.current)) throw C.fail('CSV_WRITER_UNTRACKED_CHANGE');
          for (const [operationId, expected] of Object.entries(header.physical.operations))
            if (fingerprint((await get(tx, imports.doc(operationId))).data() ?? null) !== fingerprint(expected)) throw C.fail('CSV_WRITER_UNTRACKED_CHANGE');
        }
        if (entry.exists && kind === 'operation' && fingerprint((await get(tx, imports.doc(id))).data()) !== fingerprint(header.physical)) throw C.fail('CSV_WRITER_UNTRACKED_CHANGE');
        if (entry.exists && kind === 'legacyUsers' && fingerprint((await rows(oldUsers, tx, true)).members) !== fingerprint(entry.value)) throw C.fail('CSV_WRITER_UNTRACKED_CHANGE');
        if (entry.exists && kind === 'candidate') {
          const active = (await get(tx, current)).data();
          if (entry.value.legacyList || active?.revision === id) {
            const physical = await rows(entry.value.legacyList ? oldUsers : imports.doc(id).collection('members'), tx, entry.value.legacyList === true);
            if (fingerprint(physical.members) !== fingerprint(entry.value.members)) throw C.fail('CSV_WRITER_UNTRACKED_CHANGE');
          }
        }
        return { entry, revision: header.revision, generation: header.generation, ownedOperations: header.ownedOperations || [] };
      }
      let value, token = '0';
      if (kind === 'legacyUsers') { const data = await rows(oldUsers, tx, true); value = data.members; token = `u:${data.stamp}`; }
      if (kind === 'control') {
        const raw = stateValue((await get(tx, current)).data() ?? null), data = await rows(oldUsers, tx, true);
        let active = null;
        if (raw) {
          const members = (await rows(imports.doc(raw.revision).collection('members'), tx)).members;
          const operation = (await get(tx, imports.doc(raw.revision))).data(); C.fromLegacyOperation(operation);
          if (operation.status !== 'completed' || members.length !== raw.count) throw C.fail('CSV_WRITER_MIGRATION_REQUIRED');
          active = { ...raw, fingerprint: C.digest(members), ...(raw.updatedAt===0 ? {publicUpdatedAt:null} : {}) };
        } else if (data.members.length) active = { revision: fingerprint(data.members).slice(0,32), publicRevision: data.legacyRevision, count: data.members.length, fingerprint: C.digest(data.members), updatedAt: null };
        value = { active, operations: {}, baseRevision: data.legacyRevision }; C.controlValue(value);
        token = `u:${fingerprint({ raw, stamp: data.stamp, value })}`;
      }
      if (kind === 'candidate') {
        const fallback = await rows(oldUsers, tx, true);
        const isLegacy = fallback.members.length && fingerprint(fallback.members).slice(0,32) === id;
        const data = isLegacy ? fallback : await rows(imports.doc(id).collection('members'), tx);
        if (data.members.length) { value = { members: data.members, fingerprint: C.digest(data.members), ...(isLegacy ? { legacyList: true } : {}) }; token = `u:${data.stamp}`; }
      }
      if (kind === 'operation') {
        const control = (await get(tx, heads.doc(encodeKey('csv/control')))).data();
        const inline = control?.ownedOperations?.includes(id) || control?.exists && decodeValue(control.payload).operations[id];
        const doc = await get(tx, imports.doc(id));
        if (doc.exists && !inline) { value = C.fromLegacyOperation(doc.data()); token = `u:${doc.updateTime.seconds}:${doc.updateTime.nanoseconds}`; }
      }
      return { entry: value === undefined ? absent(key) : { key, exists: true, token, value }, revision: 0, generation: 0 };
    }
    async function stageBlob(id, entry) {
      const { kind } = C.checkCsvKey(entry.key); if (!entry.exists || !['candidate','legacyUsers'].includes(kind)) return;
      const members = kind === 'candidate' ? entry.value.members : entry.value;
      const collection = payloads.doc(id).collection('members');
      const existing = new Map((await get(null,collection)).docs.map(doc=>[doc.id,doc.data()]));
      for(const [channelId,value] of existing) if(!members.some(member=>member.channelId===channelId && fingerprint(member)===fingerprint(value)))throw C.fail('CSV_WRITER_TARGET_CONFLICT');
      for (let offset = 0; offset < members.length; offset += 400) {
        const batch = collection.firestore.batch(); for (const member of members.slice(offset, offset + 400)) if(!existing.has(member.channelId))batch.create(collection.doc(member.channelId), member);
        await access.guarded(batch.commit(), true);
      }
      if (fingerprint((await rows(collection, undefined, kind === 'legacyUsers' || entry.value.legacyList === true)).members) !== fingerprint(members)) throw C.fail('CSV_WRITER_UNTRACKED_CHANGE');
    }
    async function mirror(collection, members, legacy = false) {
      const existing = await get(null, collection), byId = new Map(members.map(member => [member.channelId, member]));
      if(fingerprint(existing.docs.map(doc=>doc.data()).sort((a,b)=>a.channelId.localeCompare(b.channelId)))===fingerprint(members))return;
      const changes = [...existing.docs.filter(doc => !byId.has(doc.id)).map(doc => ({ ref: doc.ref })), ...members.map(member => ({ ref: collection.doc(member.channelId), member }))];
      for (let offset = 0; offset < changes.length; offset += 400) { const batch = collection.firestore.batch();
        for (const change of changes.slice(offset,offset+400)) if (change.member) batch.set(change.ref, change.member); else batch.delete(change.ref);
        await access.guarded(batch.commit(), true); }
      if (fingerprint((await rows(collection, undefined, legacy)).members) !== fingerprint(members)) throw C.fail('CSV_WRITER_UNTRACKED_CHANGE');
    }
    async function resultFor(id, record) {
      if (record.legacyResult) return record.legacyResult;
      const candidate = (await inspect(`csv/candidate/${id}`)).entry; if (!candidate.exists) throw C.fail('CSV_WRITER_MIGRATION_REQUIRED');
      const tiers = new Map(); for (const member of candidate.value.members) tiers.set(member.levelName,(tiers.get(member.levelName)||0)+1);
      return { count: candidate.value.members.length, tiers: [...tiers].map(([levelName,count])=>({levelName,count})), revision:id, updatedAt:record.completedAt };
    }
    async function physicalFor(entry) {
      const { kind, id } = C.checkCsvKey(entry.key);
      if (!entry.exists) return null;
      if (kind === 'operation') { const result = C.physicalOperation(entry.value); if (entry.value.status === 'completed') result.result = await resultFor(id,entry.value); return result; }
      if (kind !== 'control') return;
      const value = entry.value, active = value.active;
      if (active) { const candidate = (await inspect(`csv/candidate/${active.revision}`)).entry;
        if (!candidate.exists || candidate.value.fingerprint !== active.fingerprint || candidate.value.members.length !== active.count) throw C.fail('CSV_WRITER_MIGRATION_REQUIRED');
        if (!active.publicRevision) await mirror(imports.doc(active.revision).collection('members'),candidate.value.members);
      }
      const operations = {};
      for (const [operationId,record] of Object.entries(value.operations)) { operations[operationId]=C.physicalOperation(record); if(record.status==='completed') operations[operationId].result=await resultFor(operationId,record); }
      return { current: active && !active.publicRevision ? {revision:active.revision,count:active.count,updatedAt:active.updatedAt} : null, operations };
    }
    function proof(raw,id,digest) { if(!raw || raw.id!==id || raw.digest!==digest || !['write','projection','cancelled'].includes(raw.kind)) throw C.fail('CSV_WRITER_RECEIPT_CONFLICT'); return raw; }
    async function decode(raw) {
      if (raw.kind==='cancelled') return {id:raw.id,digest:raw.digest,outcome:'cancelled'};
      const entry=decodeValue(raw.entry); if(raw.body) entry.value=await bodyFrom(raw.body,entry.key);
      return {id:raw.id,digest:raw.digest,changes:[entry],result:decodeValue(raw.result)};
    }
    async function write(id,digest,entry,expected,op,fenced=false) {
      const receipt=receipts.doc(id), previous=(await get(null,receipt)).data(); if(previous) {
        proof(previous,id,digest); if(previous.kind==='projection' && entry.exists && C.checkCsvKey(entry.key).kind==='legacyUsers')await mirror(oldUsers,entry.value,true); return previous;
      }
      if(!fenced) { await stageBlob(id,entry); }
      const physical=!fenced && await physicalFor(entry), ref=heads.doc(encodeKey(entry.key)), info=C.checkCsvKey(entry.key);
      await access.guarded(db.runTransaction(async tx=>{
        const prior=(await get(tx,receipt)).data(); if(prior){proof(prior,id,digest);return;}
        if(fenced){tx.create(receipt,{id,digest,kind:'cancelled',reason:'fenced'});return;}
        const observed=await inspect(entry.key,tx), control=op && (info.kind==='control'?observed:await inspect('csv/control',tx));
        const conflict=observed.entry.token!==expected.token || expected.exists!==undefined && content(observed.entry)!==content(expected)
          || op && control.entry.token!==op.details.controlToken;
        const expired=op && C.inactive(op,control.entry.value,now);
        if(conflict || expired){if(!op) throw C.fail('CSV_WRITER_TARGET_CONFLICT'); tx.create(receipt,{id,digest,kind:'cancelled',reason:expired?'inactive':'conflict'});return;}
        const revision=observed.revision+1,generation=observed.generation+(entry.exists?0:1);
        if(!Number.isSafeInteger(revision)||!Number.isSafeInteger(generation)) throw C.fail('USER_STORAGE_REVISION_EXHAUSTED');
        const large=entry.exists && ['candidate','legacyUsers'].includes(info.kind);
        const body=large?{blob:id,valueDigest:fingerprint(entry.value),...(entry.value.legacyList?{legacyList:true}:{})}:entry.exists?{payload:encodeValue(entry.value)}:{};
        tx.set(ref,{format:1,revision,generation,exists:entry.exists,digest:content(entry),...body,...(physical!==undefined?{physical:physical||null}:{}),
          ...(info.kind==='control'?{ownedOperations:[...new Set([...(observed.ownedOperations||[]),...Object.keys(entry.value?.operations||{})])]}:{})});
        if(info.kind==='control') {if(physical?.current)tx.set(current,physical.current);else tx.delete(current); for(const [operationId,value] of Object.entries(physical?.operations||{}))tx.set(imports.doc(operationId),value);}
        if(info.kind==='operation') {if(physical)tx.set(imports.doc(info.id),physical);else tx.delete(imports.doc(info.id));}
        const approved={...entry,token:`m:${revision}:${generation}`}; if(large)delete approved.value;
        tx.create(receipt,{id,digest,kind:op?'write':'projection',entry:encodeValue(approved),...(large?{body}:{}),result:encodeValue(op?.result??null)});
      }),true);
      if(!fenced && entry.exists && info.kind==='legacyUsers') await mirror(oldUsers,entry.value,true);
      return proof((await get(null,receipt)).data(),id,digest);
    }
    return { inspect, read:async key=>(await inspect(key)).entry,
      async snapshot(){const keys=new Set(['csv/control','csv/legacyUsers']);
        for(const doc of (await get(null,heads)).docs)keys.add(decodeKey(doc.id));
        const fallback=(await rows(oldUsers, undefined, true)).members;if(fallback.length)keys.add(`csv/candidate/${fingerprint(fallback).slice(0,32)}`);
        for(const doc of (await get(null,imports)).docs){C.checkCsvKey(`csv/operation/${doc.id}`);keys.add(`csv/operation/${doc.id}`);if(!(await get(null,doc.ref.collection('members'))).empty)keys.add(`csv/candidate/${doc.id}`);}
        const entries=await Promise.all([...keys].sort().map(key=>this.read(key)));return C.checkSnapshot(entries.filter(entry=>entry.exists || entry.token!=='0'));},
      commit:async op=>{const entry=C.checkCsvCommand(op);await write(op.id,op.digest,entry,{token:entry.token},op);},
      receipt:async op=>{const raw=(await get(null,receipts.doc(op.id))).data();return raw?decode(proof(raw,op.id,op.digest)):null;},
      cancellationReason:async op=>(await get(null,receipts.doc(op.id))).data()?.reason,
      fence:async op=>decode(await write(op.id,op.digest,C.checkCsvCommand(op),null,op,true)),
      async apply(id,entry,expected){C.checkCsvKey(entry.key);if(entry.exists)C.valueFor(entry.key,entry.value);const raw=await write(id,fingerprint({entry,expected}),entry,expected);if(raw.kind!=='projection')throw C.fail('CSV_WRITER_RECEIPT_CONFLICT');return(await decode(raw)).changes[0];},
    };
  })();
  const rtdb=(()=>{
    const archive=createRecordStore({database,path:'membershipCsvWriterReceipts',timeoutMs,onAmbiguousWrite});
    const records=Object.fromEntries([['control','control'],['candidate','candidates'],['operation','operations'],['legacyUsers','legacyUsers']].map(([kind,path])=>[kind,createRecordStore({database,path:`membershipCsv/${path}`,timeoutMs,onAmbiguousWrite,
      payloadCodec:{encode:(value,context)=>encodeValue(C.valueFor(kind==='control'||kind==='legacyUsers'?`csv/${kind}`:`csv/${kind}/${'0'.repeat(32)}`,value),context),decode:(value)=>decodeValue(value)},
      archiveReceipt:async(id,header)=>archive.update(`${kind}:${id}:${header.id}`,prior=>{if(prior && fingerprint(prior)!==fingerprint(header))throw C.fail('CSV_WRITER_RECEIPT_CONFLICT');return{value:header};}),
    })]));
    const store=key=>{const info=C.checkCsvKey(key);return{...info,records:records[info.kind]};};
    async function inspect(key){const target=store(key),record=await target.records.read(target.id);if(record.exists)C.valueFor(key,record.value);return{entry:{key,exists:record.exists,token:record.revision?`${record.revision}:${record.generation}`:'0',...(record.exists?{value:record.value}:{})},revision:record.revision,generation:record.generation};}
    async function header(key,id,digest,planned){const target=store(key),record=await target.records.read(target.id),old=await archive.read(`${target.kind}:${target.id}:${id}`),found=record.commitReceipt?.id===id?record.commitReceipt:old.value;
      if(!found)return null;if(found.digest!==digest||found.id!==id||!checkCommitReceipt(found,found.revision,found.generation))throw C.fail('CSV_WRITER_RECEIPT_CONFLICT');
      if(planned&&found.outcome==='committed'&&record.commitReceipt?.id===id&&content((await inspect(key)).entry)!==content(planned))throw C.fail('CSV_WRITER_UNTRACKED_CHANGE');return found;}
    const decode=(op,found)=>!found?null:found.outcome==='cancelled'?{id:op.id,digest:op.digest,outcome:'cancelled'}:{id:op.id,digest:op.digest,changes:[{...clone(op.changes[0]),token:`${found.revision}:${found.generation}`}],result:clone(op.result)};
    async function fence(op,reason='fenced'){const entry=C.checkCsvCommand(op),target=store(entry.key);for(let i=0;i<10;i++){const found=await header(entry.key,op.id,op.digest);if(found)return decode(op,found);const current=await target.records.read(target.id);
      try{await target.records.fence(target.id,current.revision,{operationId:op.id,operationDigest:op.digest,cancellationReason:reason});return decode(op,await header(entry.key,op.id,op.digest));}catch(error){if(error.code!=='USER_STORAGE_CONFLICT'||i===9)throw error;}}}
    async function write(id,digest,entry,expected,op){const found=await header(entry.key,id,digest,entry);if(found)return found;const target=store(entry.key),current=await inspect(entry.key),control=op&&(target.kind==='control'?current:await inspect('csv/control'));
      const conflict=current.entry.token!==expected.token||expected.exists!==undefined&&content(current.entry)!==content(expected)||op&&control.entry.token!==op.details.controlToken;
      const expired=op&&C.inactive(op,control.entry.value,now);
      if(conflict||expired){if(!op)throw C.fail('CSV_WRITER_TARGET_CONFLICT');await fence(op,expired?'inactive':'conflict');return header(entry.key,id,digest);}
      try{await target.records[entry.exists?'compareAndSet':'delete'](target.id,current.revision,...(entry.exists?[entry.value]:[]),{operationId:id,operationDigest:digest,
        ...(op?{validateCurrent:record=>{if(C.inactive(op,target.kind==='control'?record.value:control.entry.value,now))throw C.fail('CSV_WRITER_INACTIVE');}}:{})});}
      catch(error){if(!op||!['USER_STORAGE_CONFLICT','CSV_WRITER_INACTIVE'].includes(error.code))throw error;await fence(op,error.code==='CSV_WRITER_INACTIVE'?'inactive':'conflict');}
      return header(entry.key,id,digest,entry);}
    return{inspect,read:async key=>(await inspect(key)).entry,
      async snapshot(){const keys=[];for(const[kind,path]of[['control','control'],['candidate','candidates'],['operation','operations'],['legacyUsers','legacyUsers']]){const snap=await access.guarded(database.ref(`membershipCsv/${path}`).get(),false);snap.forEach(child=>{const id=decodeKey(child.key);if((kind==='control'||kind==='legacyUsers')&&id!=='current')throw C.fail('CSV_WRITER_INVALID_KEY');keys.push(kind==='control'||kind==='legacyUsers'?`csv/${kind}`:`csv/${kind}/${id}`);});}return C.checkSnapshot(await Promise.all(keys.sort().map(key=>this.read(key))));},
      commit:async op=>{const entry=C.checkCsvCommand(op);await write(op.id,op.digest,entry,{token:entry.token},op);},receipt:async op=>decode(op,await header(op.changes[0].key,op.id,op.digest,op.changes[0])),cancellationReason:async op=>(await header(op.changes[0].key,op.id,op.digest))?.reason,fence,
      async apply(id,entry,expected){C.checkCsvKey(entry.key);if(entry.exists)C.valueFor(entry.key,entry.value);const found=await write(id,fingerprint({entry,expected}),entry,expected);if(found.outcome!=='committed')throw C.fail('CSV_WRITER_RECEIPT_CONFLICT');return{...entry,token:`${found.revision}:${found.generation}`};},
    };
  })();
  return{legacy,rtdb};
}
module.exports={createCsvWriterAdapters};
