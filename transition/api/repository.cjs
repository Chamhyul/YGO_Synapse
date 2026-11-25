'use strict';
const { createHash, randomUUID } = require('node:crypto');
const Hangul = require('../../public/vendor/ui/1c892e8a26f8b37e51cd118e4cc61d864de6e4fc1f1df5d3386bdfe5277a0b7f.js');
const { importIdentity, prepareImport, storeImportRows, ensureInventoryLocations } = require('./inventory-import.cjs');
const fail = (code, status = 400) => Object.assign(Error(code), { status });
const id = value => typeof value === 'string' && /^[1-9]\d{0,17}$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const clearFingerprint = createHash('sha256').update(JSON.stringify({ action:'clear' })).digest('hex');
const locales = ['ko','ja','ae','cn','en','de','fr','it','es','pt'];
const hangulInitials = [...'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'];
const isOpenHangulSyllable = point => point >= 0xac00 && point <= 0xd7a3 && (point - 0xac00) % 28 === 0;
function namePattern(query){
  return [...query].map((char,index,chars)=>{
    const initial=hangulInitials.indexOf(char),point=char.codePointAt(0);
    if(initial>=0){const start=0xac00+initial*588;return '['+String.fromCodePoint(start)+'-'+String.fromCodePoint(start+587)+']';}
    // 입력 중인 마지막 음절은 받침이 확정되기 전까지 같은 초성·중성 범위에서 찾는다.
    if(index===chars.length-1&&isOpenHangulSyllable(point))return '['+char+'-'+String.fromCodePoint(point+27)+']';
    return char.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  }).join('');
}
function autocompleteKeys(query, hangul) {
  const tokens = [...query].map((char, index, chars) => {
    if (hangul && hangulInitials.includes(char)) return 'i' + char;
    if (hangul && index === chars.length - 1 && isOpenHangulSyllable(char.codePointAt(0))) return 'f' + char;
    return 'e' + char;
  });
  if (tokens.length === 1) return tokens;
  return [...new Set(tokens.slice(1).map((token, index) => tokens[index] + token))];
}
const itemSelect = `select i.id, i.variant_id::text as "variantId", v.rarity_id::text as "rarityId", i.location_id as "locationId", i.quantity::text,
  p.cid::text, p.id::text as "printingId", coalesce(i.import_details->>'number',p.number,i.unresolved_details->>'number') as number,
  p.number_status as "numberStatus", p.locale,
  case when i.import_key is not null then coalesce(i.import_details,i.unresolved_details) end as "importDetails",
  coalesce(l.name, i.unresolved_details->>'name', '미확인 카드') as name,
  coalesce(rl.label, native_rl.label, r.display_code, i.unresolved_details->>'rarity', '미확인') as rarity,
  coalesce(src.artwork_id::text,'source:'||src.id::text) as "artworkId", src.id::text as "artworkSourceId", src.official_ciid as "sourceCiid", v.is_active as "isActive", s.name as "locationName", pk.name as "packName"
  from app.inventory_items i join app.storage_locations s on s.id=i.location_id
  left join catalog.printing_variants v on v.id=i.variant_id
  left join catalog.artwork_sources src on src.id=v.artwork_source_id
  left join catalog.card_printings p on p.id=v.printing_id
  left join catalog.packs pk on pk.pid=p.pid and pk.locale=p.locale
  left join catalog.card_localizations l on l.cid=p.cid and l.locale='ko'
  left join catalog.rarities r on r.id=v.rarity_id
  left join catalog.rarity_labels rl on rl.rarity_id=r.id and rl.locale='ko' and rl.is_preferred
  left join catalog.rarity_labels native_rl on native_rl.rarity_id=r.id and native_rl.locale=p.locale and native_rl.is_preferred`;
const bootstrapStateSql=`
        select s.user_id as "userId",p.nickname,p.created_at as "createdAt",
          coalesce(h.revision,0)::text as revision,coalesce(h.generation,0)::text as generation,
          coalesce(h.state,'missing') as "inventoryState",(p.user_id is not null) as "hasProfile",
          (p.user_id is not null or coalesce(h.state='active',false)) as registered,
          (select coalesce(json_agg(l order by l.position,l.id),'[]'::json)
            from (select id,name,position from app.storage_locations) l) as locations,
          (select row_to_json(pref) from (select theme,is_detail_mode as "isDetailMode",
            hide_membership_verify as "hideMembershipVerify",read_notices as "readNotices",onboarding
            from app.user_preferences) pref) as preferences
        from app.user_subjects s left join app.user_profiles p on p.user_id=s.user_id
        left join app.inventory_heads h on h.user_id=s.user_id where s.user_id=$1`;
const loginReadQueries=require('./login-read.cjs').createLoginReadQueries(bootstrapStateSql,itemSelect);
function createRepository(db) {
  const sheetImports = new Map();
  async function accountState(client, uid) {
    const { rows: [state] } = await client.query(`
      select s.user_id as "userId", p.nickname, p.created_at as "createdAt", coalesce(h.revision,0)::text as revision,
        coalesce(h.generation,0)::text as generation, coalesce(h.state,'missing') as "inventoryState",
        (p.user_id is not null) as "hasProfile",
        (p.user_id is not null or coalesce(h.state='active',false)) as registered
      from app.user_subjects s
      left join app.user_profiles p on p.user_id=s.user_id
      left join app.inventory_heads h on h.user_id=s.user_id
      where s.user_id=$1`, [uid]);
    return state || { registered: false };
  }
  async function requireRegistered(client, uid) {
    const state = await accountState(client, uid);
    if (!state.registered) throw fail('REGISTRATION_REQUIRED', 403);
    return state;
  }
  async function lockSubject(client, uid) {
    // 신규 가입과 인벤토리 변경이 동일한 사용자 행을 잠근다.
    await client.query('select user_id from app.user_subjects where user_id=$1 for update', [uid]);
  }
  async function registrationStatus(uid) {
    return db.withUser(uid, async client => (await accountState(client, uid)).registered, { readOnly: true });
  }
  async function membershipWriteGate(uid) {
    const { rows: [gate] } = await db.readUser(uid, `
      select (select ready from app.transition_release_readiness) as ready,
        exists (select 1 from app.user_profiles where user_id=$1)
        or exists (select 1 from app.inventory_heads where user_id=$1 and state='active') as registered`);
    return gate;
  }
  async function membershipStatus(uid) {
    return db.withUser(uid, async client => {
      await requireRegistered(client, uid);
      const { rows: [membership] } = await client.query(
        'select provider,status,level_name as "levelName" from app.user_memberships where user_id=$1', [uid]);
      return membership || { provider: null, status: 'unknown', levelName: null };
    }, { readOnly: true });
  }
  async function completeRegistration(uid, versions) {
    return db.withUser(uid, async client => {
      await client.query('insert into app.user_subjects (user_id) values ($1) on conflict do nothing', [uid]);
      await lockSubject(client, uid);
      if ((await accountState(client, uid)).registered) return;
      await client.query(`
        insert into app.user_profiles (user_id,created_at,registration_completed)
        values ($1,now(),true)`, [uid]);
      await client.query(`
        insert into app.user_consents (user_id,document_type,document_version,accepted_at)
        values ($1,'terms',$2,now()),($1,'privacy',$3,now())`, [uid, versions.terms, versions.privacy]);
    });
  }
  async function importStatus(uid, requestId, fingerprint) {
    const identity = importIdentity(uid, requestId, fingerprint);
    return db.withUser(uid, async client => {
      const receipt = await readImportReceipt(client, uid, identity);
      // 예약은 준비 단계만 고정한다. 같은 세대에서는 같은 키로 준비를 다시 시도할 수 있다.
      if (receipt && receipt.status !== 'reserved') {
        return { importRequest: { status: receipt.status }, ...(receipt.result ? { result: receipt.result } : {}) };
      }
      const { generation } = await requireRegistered(client, uid);
      await requireImportCoverage(client);
      return { importRequest: { status: 'missing', generation } };
    }, { readOnly: true });
  }
  async function readImportReceipt(client, uid, identity) {
    const { rows: [receipt] } = await client.query(`
      select fingerprint,status,result,bound_generation::text as generation
      from app.inventory_import_receipts where user_id=$1 and operation_id=$2`, [uid,identity.operationId]);
    if (receipt && receipt.fingerprint !== identity.fingerprint) throw fail('IMPORT_REQUEST_CONFLICT', 409);
    return receipt;
  }
  async function requireImportCoverage(client) {
    const { rows: [coverage] } = await client.query('select verified from app.import_receipt_coverage where singleton');
    if (!coverage?.verified) throw fail('IMPORT_RETRY_UNAVAILABLE', 503);
  }
  function checkGeneration(current, expected) {
    if (current !== expected) throw fail('INVENTORY_GENERATION_CHANGED', 409);
  }
  function checkImportReceipt(receipt, generation) {
    if (!receipt || receipt.status === 'completed') return;
    if (receipt.status === 'cancelled') throw fail('IMPORT_REQUEST_CANCELLED', 409);
    if (receipt.status === 'pending') throw fail('IMPORT_REQUEST_PENDING', 409);
    checkGeneration(receipt.generation, generation);
  }
  async function inventoryGeneration(uid) {
    return db.withUser(uid, async client => (await requireRegistered(client, uid)).generation, { readOnly: true });
  }
  async function clearInventory(uid, requestId) {
    if (!uuid(requestId)) throw fail('INVALID_COMMAND');
    return db.withUser(uid, async client => {
      await lockSubject(client, uid);
      const { rows: [prior] } = await client.query(
        'select fingerprint,result from app.inventory_operations where user_id=$1 and request_id=$2', [uid,requestId]);
      if (prior) {
        if (prior.fingerprint !== clearFingerprint) throw fail('IDEMPOTENCY_CONFLICT', 409);
        return prior.result;
      }
      await requireRegistered(client, uid);
      await client.query('delete from app.inventory_items where user_id=$1', [uid]);
      await client.query('delete from app.storage_locations where user_id=$1', [uid]);
      const { rows: [{ revision }] } = await client.query(`
        insert into app.inventory_heads(user_id,state,revision,generation) values($1,'deleted',1,1)
        on conflict(user_id) do update set state='deleted',
          revision=app.inventory_heads.revision+1,generation=app.inventory_heads.generation+1
        returning revision::text`, [uid]);
      await client.query(`
        update app.inventory_import_receipts set status='cancelled'
        where user_id=$1 and status='reserved'`, [uid]);
      const result = { revision };
      await client.query('insert into app.inventory_operations(user_id,request_id,fingerprint,result) values($1,$2,$3,$4)',
        [uid,requestId,clearFingerprint,result]);
      return result;
    });
  }
  async function reserveImport(uid, identity, generation) {
    const admission = await db.withUser(uid, async client => {
      await lockSubject(client, uid);
      const receipt = await readImportReceipt(client, uid, identity);
      if (receipt?.status === 'completed') return { result:receipt.result };
      checkImportReceipt(receipt, generation);
      const state = await requireRegistered(client, uid);
      await requireImportCoverage(client);
      if (!receipt) await client.query(`
        insert into app.inventory_import_receipts(user_id,operation_id,fingerprint,status,bound_generation)
        values($1,$2,$3,'reserved',$4)`, [uid,identity.operationId,identity.fingerprint,generation]);
      if (state.generation !== generation) {
        await client.query(`
          update app.inventory_import_receipts set status='cancelled'
          where user_id=$1 and operation_id=$2 and status='reserved'`, [uid,identity.operationId]);
        return { cancelled:true };
      }
      return {};
    });
    if (admission.cancelled) throw fail('IMPORT_REQUEST_CANCELLED', 409);
    return admission.result;
  }

  async function saveImport(uid, source, body, identity, generation, readSheet) {
    const parsed = await prepareImport(source, body, readSheet);
    return db.withUser(uid, async client => {
      await lockSubject(client, uid);
      const receipt = await readImportReceipt(client, uid, identity);
      if (!receipt) throw fail('IMPORT_RETRY_UNAVAILABLE', 503);
      checkImportReceipt(receipt, generation);
      if (receipt.status === 'completed') return { result:receipt.result, applied:false };
      const state = await requireRegistered(client, uid);
      await requireImportCoverage(client);
      checkGeneration(state.generation, generation);
      const result = await storeImportRows(client, uid, parsed, state.revision);
      const completed = await client.query(`
        update app.inventory_import_receipts set status='completed',result=$3
        where user_id=$1 and operation_id=$2 and status='reserved'`, [uid,identity.operationId,result]);
      if (completed.rowCount !== 1) throw fail('IMPORT_RETRY_UNAVAILABLE', 503);
      return { result, applied:true };
    });
  }
  async function importInventory(uid, source, body, identity, generation, readSheet) {
    if (source !== 'sheet') return saveImport(uid,source,body,identity,generation,readSheet);
    const key = JSON.stringify([uid,identity.operationId,identity.fingerprint,generation]);
    if (sheetImports.has(key)) return sheetImports.get(key);
    const work = (async () => {
      // 다른 요청이 먼저 끝난 경우에는 시트를 다시 열지 않는다.
      const receipt = await db.withUser(uid,client=>readImportReceipt(client,uid,identity),{readOnly:true});
      if (!receipt) throw fail('IMPORT_RETRY_UNAVAILABLE',503);
      checkImportReceipt(receipt,generation);
      if (receipt.status === 'completed') return { result:receipt.result, applied:false };
      return saveImport(uid,source,body,identity,generation,readSheet);
    })();
    sheetImports.set(key,work);
    try { return await work; }
    finally { sheetImports.delete(key); }
  }
  async function items(client, ids) {
    const where = ids ? ' where i.id=any($1::uuid[])' : '';
    return (await client.query(itemSelect + where + ' order by i.id', ids ? [ids] : [])).rows;
  }
  async function summary(client) {
    return (await client.query(`select coalesce(sum(quantity),0)::text as quantity,
      count(*)::int as entries, count(distinct v.printing_id)::int as printings
      from app.inventory_items i left join catalog.printing_variants v on v.id=i.variant_id
  left join catalog.artwork_sources src on src.id=v.artwork_source_id`)).rows[0];
  }
  async function readBootstrapState(client,uid,timing=(_name,work)=>work()) {
      // 같은 UID·RLS·스냅샷 안에서 연결을 늘리지 않고 조회 왕복을 줄인다.
      return (await timing('db_state_sql',()=>client.query(bootstrapStateSql,[uid]))).rows[0];
  }
  async function prepareLoginRead(client,cid) {
    // 빈 UID는 user_subjects의 길이 제약상 존재할 수 없다. RLS는 그대로 적용한다.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      await client.query("select set_config('synapse.uid', '', true)");
      if(await readBootstrapState(client,'')||(await items(client)).length)throw Error('DB 준비에서 빈 UID 격리가 유지되지 않았습니다.');
      const {rows}=await client.query(`select p.cid::text,p.id::text as "printingId",v.rarity_id::text as "rarityId"
        from catalog.card_printings p left join catalog.printing_variants v on v.printing_id=p.id
        where p.cid=$1 order by p.id,v.id limit 1`,[cid]);
      const prepared=await require('./login-view.cjs').projectLogin(client,{items:rows.length?rows:[{cid}],locations:[]},'ko');
      JSON.stringify(prepared.catalog);
    } finally {await client.query('ROLLBACK');}
  }
  async function readBootstrap(client,uid,timing=(_name,work)=>work()) {
      const state=await readBootstrapState(client,uid,timing);
      if(!state?.registered)throw fail('REGISTRATION_REQUIRED',403);
      const inventory=await timing('db_items_sql',()=>items(client));
      return bootstrapData(state,inventory);
  }
  function bootstrapData(state,inventory){
      const { userId,nickname,createdAt,revision,generation,inventoryState,hasProfile,locations,preferences }=state;
      const printings=new Set();let quantity=0n;
      for(const item of inventory){quantity+=BigInt(item.quantity);if(item.printingId!==null)printings.add(item.printingId);}
      const summary={quantity:String(quantity),entries:inventory.length,printings:printings.size};
      return { profile:{userId,nickname,createdAt,revision},hasProfile,generation,inventoryState,locations,items:inventory,summary,
        preferences:preferences??undefined,inventoryCatalogVersion:1,inventoryCatalogBatchVersion:1,inventoryCatalogWireVersion:1 };
  }
  async function bootstrap(uid,{timing,onTiming}={}){return db.withUser(uid,client=>readBootstrap(client,uid,timing),{readOnly:true,onTiming});}
  async function loginView(uid,locale='ko',{timing=(_name,work)=>work(),onTiming}={}){
    if(!locales.includes(locale))throw fail('INVALID_QUERY');
    if(typeof db.withUserRead!=='function')return db.withUser(uid,async client=>require('./login-view.cjs').projectLogin(client,await readBootstrap(client,uid,timing),locale,{timing}),{readOnly:true,onTiming});
    return db.withUserRead(uid,loginReadQueries,async(client,[subject,inventory])=>{
      const state=subject.rows[0];if(!state?.registered)throw fail('REGISTRATION_REQUIRED',403);
      return require('./login-view.cjs').projectLogin(client,bootstrapData(state,inventory.rows),locale,{timing});
    },{onTiming});
  }
  async function createDemo(uid) {
    await db.withUser(uid, async client => {
      await client.query('insert into app.user_subjects(user_id) values($1)', [uid]);
      await client.query("insert into app.user_profiles(user_id,nickname,created_at,registration_completed) values($1,'체험 계정',now(),true)", [uid]);
      await client.query("insert into app.inventory_heads(user_id,state,next_location_number) values($1,'active',3)", [uid]);
      await client.query('insert into app.user_preferences(user_id) values($1)', [uid]);
      await client.query("insert into app.storage_locations(user_id,name,position,location_number) values($1,'미보관',1,1),($1,'바인더',2,2)", [uid]);
      await client.query(`insert into app.inventory_items(user_id,variant_id,location_id,quantity)
        select $1,v.id,s.id,2 from catalog.printing_variants v join catalog.card_printings p on p.id=v.printing_id
        join catalog.rarities r on r.id=v.rarity_id cross join app.storage_locations s
        where s.user_id=$1 and s.position=1 and p.cid=4007 and p.number='QCAC-KR021' and p.locale='ko' and r.display_code='UR' and v.is_active
        order by v.artwork_source_id,v.id limit 1`, [uid]);
    });
    return bootstrap(uid);
  }
  async function catalog(query, locale = 'ko') {
    if (typeof query !== 'string' || query.length > 100 || !locales.includes(locale)) throw fail('INVALID_QUERY');
    const { rows } = await db.pool.query(`select c.cid::text,coalesce(l.name, fallback.name) as name,c.card_type as type,
      c.atk,c.def,c.properties,c.lv,c.attribute,c.race,c.pendulum_scale as "pendulumScale",c.revision::text from catalog.cards c
      left join catalog.card_localizations l on l.cid=c.cid and l.locale=$2
      left join lateral (select name from catalog.card_localizations where cid=c.cid order by locale limit 1) fallback on true
      where $1='' or c.cid::text=$1 or exists(select from catalog.card_localizations n where n.cid=c.cid and position(lower($1) in lower(n.name))>0)
      or exists(select from catalog.card_printings p where p.cid=c.cid and position(upper($1) in p.number)>0)
      order by c.cid limit 50`, [query.normalize('NFC').trim(), locale]);
    return rows;
  }
  async function search(query,locale='ko',after='0',limit=50,{autocomplete=false}={}){
    if(typeof query!=='string'||query.length>100||!locales.includes(locale)||!/^\d{1,10}$/.test(after)||Number(after)>2147483647||!Number.isInteger(limit)||limit<1||limit>100)throw fail('INVALID_QUERY');
    const normalized=query.normalize('NFC').replace(/\s+/gu,'').toLowerCase();
    // 후보를 기존 인덱스로 좁힌 뒤 원래 이름·번호 조건과 CID 정렬을 그대로 적용한다.
    const indexed = normalized !== '';
    const args = [normalized, locale, after, limit + 1, namePattern(normalized)];
    if (indexed) {
      const exactCid = /^[1-9]\d{0,9}$/.test(normalized) && Number(normalized) <= 2147483647 ? Number(normalized) : null;
      args.push(autocompleteKeys(normalized, true), autocompleteKeys(normalized, false), exactCid);
    }
    const candidates = indexed ? `with candidates as materialized (
      select cid from (
        select n.cid from catalog.card_localizations n where n.cid > $3::integer
          and catalog.autocomplete_keys(lower(regexp_replace(n.name,'[[:space:]]','','g')),true) @> $6::text[]
          and lower(regexp_replace(n.name,'[[:space:]]','','g')) ~ $5
        union
        select p.cid from catalog.card_printings p where p.cid > $3::integer and p.number is not null
          and catalog.autocomplete_keys(lower(p.number),false) @> $7::text[]
          and position($1 in lower(p.number))>0
        union
        select cid from catalog.cards where cid = $8::integer and cid > $3::integer
      ) matches order by cid limit $4
    )` : '';
    const rows=(await db.pool.query(`${candidates} select c.cid::text,coalesce(l.name,fallback.name) as name,c.card_type as type,
      c.atk,c.def,c.properties,c.lv,c.attribute,c.race,c.pendulum_scale as "pendulumScale",c.revision::text,
      (select jsonb_agg(jsonb_build_object('locale',n.locale,'name',n.name) order by n.locale) from catalog.card_localizations n where n.cid=c.cid) as localizations,
      array(select n.name from catalog.card_localizations n where n.cid=c.cid and ($1='' or lower(regexp_replace(n.name,'[[:space:]]','','g')) ~ $5) order by n.locale) as "matchedNames",
      array(select distinct p.number from catalog.card_printings p where p.cid=c.cid and p.number is not null and $1<>'' and position($1 in lower(p.number))>0 order by p.number) as "matchedNumbers"
      from catalog.cards c ${indexed ? 'join candidates using (cid)' : ''}
      left join catalog.card_localizations l on l.cid=c.cid and l.locale=$2
      left join lateral(select name from catalog.card_localizations where cid=c.cid order by locale limit 1) fallback on true
      ${indexed ? '' : `where c.cid>$3::integer and ($1='' or c.cid::text=$1
       or exists(select from catalog.card_localizations n where n.cid=c.cid and lower(regexp_replace(n.name,'[[:space:]]','','g')) ~ $5)
       or exists(select from catalog.card_printings p where p.cid=c.cid and position($1 in lower(p.number))>0))`}
      order by c.cid limit $4`,args)).rows;
    const more=rows.length>limit,cards=rows.slice(0,limit);return {cards,next:more?cards.at(-1).cid:null};
  }
  async function details(cards, locale, { combine = false, inventoryOnly = false, rarityGroups, queryable = db.pool, timing = (_name,work)=>work() } = {}) {
    if (!cards.length) return [];
    const ids = cards.map(c=>c.cid);
    const printingsTable = combine ? 'selected_printings' : 'catalog.card_printings';
    const variantsTable = combine ? 'selected_variants' : 'catalog.printing_variants';
    const sourcesTable = combine ? 'selected_sources' : 'catalog.artwork_sources';
    const packsTable = combine ? 'selected_packs' : 'catalog.packs';
    const raritySource = combine ? 'selected_variants v'
      : 'catalog.printing_variants v join catalog.card_printings p on p.id=v.printing_id where p.cid=any($1::integer[])';
    const printingsSql = `select p.cid::text,p.id::text as id,p.pid,p.locale,p.number,p.number_status as "numberStatus",${combine?'null::text':'pk.name'} as "packName",${combine?'null::integer':'pk.reported_card_count'} as "reportedCardCount"
      from ${printingsTable} p join ${packsTable} pk on pk.pid=p.pid and pk.locale=p.locale
      where p.cid=any($1::integer[])
      order by p.locale,p.id`;
    const variantsSql = `select p.cid::text,v.id::text as id,v.printing_id::text as "printingId",v.rarity_id::text as "rarityId",coalesce(src.artwork_id::text,'source:'||src.id::text) as "artworkId", src.id::text as "artworkSourceId",
      null::text as rarity,null::text as "displayCode",
      src.official_ciid as "sourceCiid"
      from ${variantsTable} v join ${printingsTable} p on p.id=v.printing_id
      join ${sourcesTable} src on src.id=v.artwork_source_id
      join catalog.rarities r on r.id=v.rarity_id
      where p.cid=any($1::integer[]) and v.is_active order by p.id,r.sort_order,src.id`;
    const sourcesSql = `select s.cid::text,s.id::text as id,s.locale,s.official_ciid as ciid,s.artwork_id::text as "groupId",s.image_ciid as "imageCiid",s.image_variant as "imageVariant",
      false as released
      from ${sourcesTable} s where s.cid=any($1::integer[]) order by s.id`;
    const localizationsSql = `select cid::text,locale,name${inventoryOnly ? '' : ',card_text as "text",pendulum_text as "pendulumText"'} from catalog.card_localizations where cid=any($1::integer[]) order by cid,locale`;
    const groupedRarities = rarityGroups ? `select distinct g.group_index,v.rarity_id
      from selected_variants v join selected_printings p on p.id=v.printing_id
      join unnest($1::integer[],$2::bigint[]) as g(cid,group_index) on g.cid=p.cid` : null;
    const raritiesSql = groupedRarities ? `select g.group_index as "batchIndex",r.id::text,r.display_code as "displayCode",r.sort_order as "sortOrder",
      coalesce(jsonb_object_agg(l.locale,l.label) filter(where l.label is not null),'{}') as labels,
      coalesce(jsonb_object_agg(l.locale,l.display_code) filter(where l.display_code is not null),'{}') as "displayCodes"
      from (${groupedRarities}) g join catalog.rarities r on r.id=g.rarity_id
      left join catalog.rarity_labels l on l.rarity_id=r.id and l.is_preferred
      group by g.group_index,r.id order by g.group_index,r.sort_order,r.id` : `select r.id::text,r.display_code as "displayCode",r.sort_order as "sortOrder",coalesce(jsonb_object_agg(l.locale,l.label) filter(where l.label is not null),'{}') as labels,coalesce(jsonb_object_agg(l.locale,l.display_code) filter(where l.display_code is not null),'{}') as "displayCodes" from catalog.rarities r left join catalog.rarity_labels l on l.rarity_id=r.id and l.is_preferred
      where r.id in (select v.rarity_id from ${raritySource}) group by r.id order by r.sort_order,r.id`;
    const queries = [
      [printingsSql, [ids]], [variantsSql, [ids]], [sourcesSql, [ids]],
      [localizationsSql, [ids]], [raritiesSql, [ids]],
    ];
    const results = [];
    if (combine) {
      // 레어도 목록에는 비활성 변형도 필요하므로 활성 조건은 상세 변형 조회에만 적용한다.
      // DB→API에서도 필드명을 반복 전송하지 않는다. API 객체는 아래에서 정확히 복원한다.
      const fields=[
        ['cid','id','pid','locale','number','numberStatus','packName','reportedCardCount'],
        ['cid','id','printingId','rarityId','artworkId','artworkSourceId','rarity','displayCode','sourceCiid'],
        ['cid','id','locale','ciid','groupId','imageCiid','imageVariant','released'],
        ['cid','locale','name',...(inventoryOnly?[]:['text','pendulumText'])],
        [...(rarityGroups?['batchIndex']:[]),'id','displayCode','sortOrder','labels','displayCodes'],
      ];
      const columns = queries.map(([sql], index) =>
        `(select coalesce(json_agg(json_build_array(${fields[index].map(key=>`detail."${key}"`).join(',')})),'[]'::json) from (${sql}) detail) as detail_${index}`);
      columns.push(`(select coalesce(json_agg(json_build_array(pid,locale,name,reported_card_count)),'[]'::json) from selected_packs) as detail_packs`);
      const {rows:[page]} = await timing('catalog_detail_sql',()=>queryable.query(`
        with selected_printings as materialized (
          select id,cid,pid,locale,number,number_status from catalog.card_printings where cid=any($1::integer[])
        ), selected_variants as materialized (
          select v.id,v.printing_id,v.rarity_id,v.artwork_source_id,v.is_active from selected_printings p join catalog.printing_variants v on p.id=v.printing_id
        ), selected_sources as materialized (
          select id,cid,locale,official_ciid,artwork_id,image_ciid,image_variant from catalog.artwork_sources where cid=any($1::integer[])
        ), selected_packs as materialized (
          select pk.pid,pk.locale,pk.name,pk.reported_card_count from catalog.packs pk
          join (select distinct pid,locale from selected_printings) keys using(pid,locale)
        )
        select ${columns.join(', ')}`, rarityGroups ? [ids,ids.map(cid=>rarityGroups.get(cid))] : [ids]));
      queries.forEach((_, index) => results.push(page[`detail_${index}`].map(row=>{
        if(!Array.isArray(row))return row;
        if(row.length!==fields[index].length)throw fail('CATALOG_INVALID_RESULT',503);
        return Object.fromEntries(fields[index].map((key,i)=>[key,row[i]]));
      })));
      if(Array.isArray(page.detail_packs)){
        const packs=new Map(page.detail_packs.map(([pid,locale,name,count])=>[pid+':'+locale,{name,count}]));
        for(const printing of results[0]){const pack=packs.get(printing.pid+':'+printing.locale);if(!pack)throw fail('CATALOG_INVALID_RESULT',503);printing.packName=pack.name;printing.reportedCardCount=pack.count;}
      }
    } else {
      for (const [sql, params] of queries) results.push((await queryable.query(sql, params)).rows);
    }
    return timing('catalog_shape',()=>{
    const [printings, variants, sourceRows, localizations, rarities] = results;
    // 같은 조회에서 받은 우선 라벨로 기존 SQL COALESCE 순서를 복원한다.
    const rarityById=new Map(rarities.map(row=>[row.id,row])),printingById=new Map(printings.map(row=>[row.id,row]));
    for(const variant of variants){
      const rarity=rarityById.get(variant.rarityId),native=printingById.get(variant.printingId)?.locale;
      variant.rarity=rarity?.labels?.[locale]??rarity?.labels?.[native]??rarity?.displayCode??'미확인';
      variant.displayCode=rarity?.displayCodes?.[locale]??rarity?.displayCodes?.[native]??rarity?.displayCode??null;
    }
    const releasedSources=new Set(variants.map(variant=>variant.artworkSourceId));
    for(const source of sourceRows)source.released=releasedSources.has(source.id);
    const grouped=new Map();for(const source of sourceRows){const id=source.groupId||'source:'+source.id;const key=source.cid+':'+id;
      if(!grouped.has(key))grouped.set(key,{cid:source.cid,id,locales:[],sources:[]});const art=grouped.get(key);art.sources.push(source);if(source.released&&!art.locales.includes(source.locale))art.locales.push(source.locale);}
    const artworks=[...grouped.values()];
    const byCid=rows=>{const map=new Map();for(const row of rows){if(!map.has(row.cid))map.set(row.cid,[]);map.get(row.cid).push(row);}return map;};
    const localized=byCid(localizations),printed=byCid(printings),varied=byCid(variants),illustrated=byCid(artworks);
    const groupedRarityRows=new Map();
    if(rarityGroups)for(const {batchIndex,...rarity} of rarities){
      if(!groupedRarityRows.has(batchIndex))groupedRarityRows.set(batchIndex,[]);
      groupedRarityRows.get(batchIndex).push(rarity);
    }
    return cards.map(selected=>({...selected,...(inventoryOnly?{inventoryOnly:true}:{}),localizations:localized.get(selected.cid)||[],rarities:rarityGroups?(groupedRarityRows.get(rarityGroups.get(selected.cid))||[]):rarities,
      printings:printed.get(selected.cid)||[],variants:varied.get(selected.cid)||[],artworks:illustrated.get(selected.cid)||[]}));
    });
  }

  async function catalogDetails(query, locale = 'ko') { return details(await catalog(query,locale),locale); }
  async function selectedCards(cids,locale,queryable=db.pool){
    const { rows } = await queryable.query(`
          select c.cid::text,coalesce(l.name,fallback.name) as name,c.card_type as type,
            c.atk,c.def,c.properties,c.lv,c.attribute,c.race,c.pendulum_scale as "pendulumScale",c.revision::text
          from catalog.cards c
          left join catalog.card_localizations l on l.cid=c.cid and l.locale=$2
          left join lateral (select name from catalog.card_localizations where cid=c.cid order by locale limit 1) fallback on true
          where c.cid=any($1::integer[]) order by c.cid`, [cids,locale]);
    return rows;
  }
  async function inventoryCardBatches({locale='ko',groups,wireFormat,...extra}, {cancelled=()=>false,timing=(_name,work)=>work()}={}) {
    if((wireFormat!==undefined && wireFormat!=='shared-rarities-v1') || !locales.includes(locale) || Object.keys(extra).length || !Array.isArray(groups) || groups.length<1 || groups.length>4)throw fail('INVALID_QUERY');
    const indexes=new Set(),cids=new Set();
    // 모든 입력을 확인한 뒤 조회한다. 묶음별 레어도·CID 정렬 계약은 기존 함수가 유지한다.
    for(const group of groups){
      if(!group || typeof group!=='object' || Array.isArray(group) || Object.keys(group).some(key=>!['index','cids'].includes(key))
        || !Number.isSafeInteger(group.index) || group.index<0 || indexes.has(group.index)
        || !Array.isArray(group.cids) || group.cids.length<1 || group.cids.length>25)throw fail('INVALID_QUERY');
      indexes.add(group.index);
      for(const cid of group.cids){
        if(!id(cid) || Number(cid)>2147483647 || cids.has(cid))throw fail('INVALID_QUERY');
        cids.add(cid);
      }
    }
    if(cancelled())throw fail('REQUEST_CANCELLED',499);
    // 같은 최대100종을 두 번만 읽고, 묶음별 레어도 범위와 정렬은 그대로 나눈다.
    const rarityGroups=new Map(groups.flatMap(group=>group.cids.map(cid=>[cid,group.index])));
    const connection=db.pool.connect ? await timing('catalog_connect',()=>db.pool.connect()) : null;
    try{
      if(cancelled())throw fail('REQUEST_CANCELLED',499);
      const queryable=connection||db.pool;
      const selected=await timing('catalog_base',()=>selectedCards([...cids],locale,queryable));
      if(cancelled())throw fail('REQUEST_CANCELLED',499);
      const cards=await details(selected,locale,{combine:true,inventoryOnly:true,rarityGroups,queryable,timing});
      if(cancelled())throw fail('REQUEST_CANCELLED',499);
      const results=groups.map(group=>({index:group.index,cards:cards.filter(card=>rarityGroups.get(card.cid)===group.index)}));
      if(wireFormat)return {wireVersion:1,groups:results.map(({index,cards})=>({index,rarities:cards[0]?.rarities||[],cards:cards.map(({rarities,...card})=>card)}))};
      return {groups:results};
    }finally{connection?.release();}
  }
  async function registrationCards({ locale = 'ko', names, cids, includeDetails, inventoryOnly, ...extra }) {
    if (!locales.includes(locale) || Object.keys(extra).length || (names === undefined) === (cids === undefined)) throw fail('INVALID_QUERY');
    if (includeDetails !== undefined && (includeDetails !== true || cids === undefined)) throw fail('INVALID_QUERY');
    if (inventoryOnly !== undefined && (inventoryOnly !== true || includeDetails !== true)) throw fail('INVALID_QUERY');
    if (cids !== undefined) {
      if (!Array.isArray(cids) || cids.length < 1 || cids.length > (includeDetails ? 25 : 100) ||
        !cids.every(cid => id(cid) && Number(cid) <= 2147483647)) throw fail('INVALID_QUERY');
      if (includeDetails) {
        const rows=await selectedCards(cids,locale);
        return { cards:await details(rows,locale,{combine:true,inventoryOnly:inventoryOnly===true}) };
      }
      const { rows } = await db.pool.query(`
        select cid::text, coalesce(max(name) filter(where locale=$2),(array_agg(name order by locale))[1]) as name,
          jsonb_agg(jsonb_build_object('locale',locale,'name',name)) as localizations
        from catalog.card_localizations where cid=any($1::integer[]) group by cid`, [cids,locale]);
      return { cards:rows };
    }
    if (!Array.isArray(names) || names.length < 1 || names.length > 25 ||
      !names.every(name => typeof name === 'string' && name.length <= 100 && name.trim())) throw fail('INVALID_QUERY');
    const normalized = [...new Set(names.map(name=>name.normalize('NFC').trim()))];
    const { rows } = await db.pool.query(`
      with resolved as (
        select name,min(cid) as cid from catalog.card_localizations
        where name=any($1::text[]) group by name having count(distinct cid)=1
      ), selected as (
        select cid,array_agg(name) as names from resolved group by cid
      )
      select c.cid::text,coalesce(l.name,fallback.name) as name,c.card_type as type,
        c.atk,c.def,c.properties,c.lv,c.attribute,c.race,c.pendulum_scale as "pendulumScale",c.revision::text,s.names
      from selected s join catalog.cards c using(cid)
      left join catalog.card_localizations l on l.cid=c.cid and l.locale=$2
      left join lateral (select name from catalog.card_localizations where cid=c.cid order by locale limit 1) fallback on l.name is null
      order by c.cid`, [normalized,locale]);
    const matches = rows.flatMap(({cid,names})=>names.map(name=>[name,cid]));
    const cards = await details(rows.map(({names,...card})=>card),locale);
    return { cards,matches };
  }
  const packDisplayName = "regexp_replace(btrim(p.name),'[[:space:]]+',' ','g')";
  const confirmedPack = `count(distinct m.position)=count(*)
    and (p.reported_card_count is null or p.reported_card_count=count(*))
    and bool_and(coalesce(l.name,'')<>'' and exists(
      select from catalog.card_printings cp where cp.pid=m.pid and cp.locale=m.locale and cp.cid=m.cid
        and exists(select from catalog.printing_variants v where v.printing_id=cp.id and v.is_active)
    ))`;
  const normalizePackSearch = value => value.normalize('NFC').replace(/\s+/gu,'').toLowerCase();
  let packNameCatalog, packNameCatalogRequest;
  async function loadPackNameCatalog() {
    const {rows} = await db.pool.query(`select p.pid,p.locale,${packDisplayName} as name
      from catalog.packs p where p.pid ~ '^[a-zA-Z0-9-]{1,40}$' order by name`);
    const versionsByName = new Map();
    for (const {name,pid,locale} of rows) {
      if (!versionsByName.has(name)) versionsByName.set(name,[]);
      versionsByName.get(name).push({pid,locale});
    }
    return [...versionsByName].flatMap(([name,versions]) => {
      const normalized = normalizePackSearch(name);
      if (!normalized) return [];
      return [{name,normalized,versions:JSON.stringify(versions)}];
    });
  }
  async function getPackNameCatalog() {
    if (packNameCatalog && Date.now()<packNameCatalog.expiresAt) return packNameCatalog.entries;
    packNameCatalogRequest ??= loadPackNameCatalog().then(entries => {
      packNameCatalog = { entries, expiresAt:Date.now()+30_000 };
      return entries;
    }).finally(() => { packNameCatalogRequest = null; });
    return packNameCatalogRequest;
  }
  async function findPackSuggestions(query) {
    if (typeof query !== 'string' || query.length>160) throw fail('INVALID_QUERY');
    const term = normalizePackSearch(query);
    const catalog = await getPackNameCatalog();
    const matches = catalog.flatMap(({name,normalized,versions}) => {
      const position = term ? Hangul.search(normalized,term) : 0;
      return position < 0 ? [] : [{name,versions,rank:normalized===term?0:position===0?1:2}];
    }).sort((a,b)=>a.rank-b.rank);
    if (!matches.length) return [];
    const names = matches.map(({name})=>name);
    const versions = matches.map(entry=>entry.versions);
    // 수록 확정 상태는 카탈로그 캐시와 별도로 매번 확인한다.
    const available = await db.pool.query(`select candidate.name
      from unnest($1::text[],$2::text[]) with ordinality as candidate(name,versions,position)
      where exists (
        select 1 from jsonb_to_recordset(candidate.versions::jsonb) as version(pid text,locale text)
        where exists (
          select 1 from catalog.packs p join catalog.pack_cards m using(pid,locale)
          left join catalog.card_localizations l on l.cid=m.cid and l.locale=m.locale
          where p.pid=version.pid and p.locale=version.locale and ${packDisplayName}=candidate.name
          group by p.pid,p.locale,p.reported_card_count having ${confirmedPack}
        )
      )
      order by candidate.position limit 5`,[names,versions]);
    return available.rows.map(({name})=>name);
  }
  async function findPacks(name) {
    if (typeof name !== 'string' || !name.trim() || name.length>160) throw fail('INVALID_QUERY');
    const normalized=name.normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g,'').replace(/\s+/gu,' ').trim();
    const { rows } = await db.pool.query(`
      select p.pid,p.locale,p.name,count(m.cid)::int as "totalCards"
      from catalog.packs p join catalog.pack_cards m using(pid,locale)
      left join catalog.card_localizations l on l.cid=m.cid and l.locale=m.locale
      where ${packDisplayName}=$1
        and p.pid ~ '^[a-zA-Z0-9-]{1,40}$'
      group by p.pid,p.locale,p.name,p.reported_card_count
      having ${confirmedPack}
      order by p.locale,p.pid limit 50`,[normalized]);
    return rows;
  }
  async function packCards(pid,locale,{offset=0,limit=20,summaryOnly=false}={}) {
    if (!/^[a-z0-9-]{1,40}$/i.test(pid||'') || !locales.includes(locale)
      || !Number.isSafeInteger(offset) || offset<0 || offset>5000 || !Number.isInteger(limit) || limit<1 || limit>20) throw fail('INVALID_QUERY');
    // 전체 수록 검증과 페이지 선택은 같은 SQL 스냅샷에서 수행한다.
    const { rows } = await db.pool.query(`
      with confirmed as (
        select p.name as "packName",p.reported_card_count as "reportedCardCount",count(*)::int as total
          ${summaryOnly ? ',array_agg(m.cid::text order by m.position) as cids' : ''}
        from catalog.pack_cards m join catalog.packs p using(pid,locale)
        left join catalog.card_localizations l on l.cid=m.cid and l.locale=m.locale
        where m.pid=$1 and m.locale=$2
        group by p.name,p.reported_card_count
        having ${confirmedPack}
      )
      ${summaryOnly ? 'select cids,"packName",total from confirmed' : `
        select confirmed.*,page.*
        from confirmed
        left join lateral (
          select m.cid::text,l.name,c.card_type as type,c.atk,c.def,c.properties,c.lv,c.attribute,c.race,c.pendulum_scale as "pendulumScale",
            coalesce((select jsonb_agg(jsonb_build_object('id',p.id::text,'uniqueNumber',p.number is not null
              and not exists(select from catalog.card_printings other where other.number=p.number and other.id<>p.id))
              order by p.id) from catalog.card_printings p where p.pid=$1 and p.locale=$2 and p.cid=m.cid
              and exists(select from catalog.printing_variants v where v.printing_id=p.id and v.is_active)),'[]') as "packPrintings",
            m.position
          from (
            select cid,position from catalog.pack_cards where pid=$1 and locale=$2
            order by position limit $3 offset $4
          ) m
          join catalog.cards c using(cid)
          join catalog.card_localizations l on l.cid=m.cid and l.locale=$2
        ) page on true
        order by page.position`}`,summaryOnly ? [pid,locale] : [pid,locale,limit,offset]);
    if (!rows.length) throw fail('PACK_UNAVAILABLE',404);
    if (summaryOnly) return rows[0];
    const total=rows[0].total;
    const page=rows[0].cid===null ? [] : rows.map(({total,...card})=>card);
    return { cards:await details(page,locale,{combine:true}),total };
  }
  async function card(cid, locale = 'ko') {
    if (!id(cid) || BigInt(cid)>2147483647n || !locales.includes(locale)) throw fail('INVALID_QUERY');
    const { cards } = await registrationCards({ cids: [cid], locale, includeDetails: true });
    if (!cards.length) throw fail('NOT_FOUND',404);
    return cards[0];
  }
  async function addLocation(uid, name, generation) {
    if (typeof name !== 'string' || !(name = name.normalize('NFC').trim()) || name.length > 80) throw fail('INVALID_LOCATION');
    return db.withUser(uid, async client => {
      await lockSubject(client, uid);
      const state = await requireRegistered(client, uid);
      checkGeneration(state.generation, generation);
      const { rows: [existing] } = await client.query(
        'select id,name,position from app.storage_locations where user_id=$1 and name=$2', [uid,name]);
      if (existing) return existing;
      const { rows: [head] } = await client.query(`
        insert into app.inventory_heads(user_id,state,revision,next_location_number) values ($1,'active',1,2)
        on conflict(user_id) do update set state='active',
          revision=app.inventory_heads.revision+1,
          next_location_number=app.inventory_heads.next_location_number+1
        returning next_location_number-1 as number`, [uid]);
      return (await client.query(`insert into app.storage_locations(user_id,name,position,location_number)
        select $1,$2,coalesce(max(position),0)+1,$3 from app.storage_locations where user_id=$1
        returning id,name,position`, [uid,name,head.number])).rows[0];
    });
  }
  function validateCommand(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(k => !['requestId','action','variantId','itemId','locationId','quantity'].includes(k)) ||
      !uuid(body.requestId) || !['add','move','discard'].includes(body.action) ||
      !Number.isSafeInteger(body.quantity) || body.quantity < 1) throw fail('INVALID_COMMAND');
    if (body.action === 'add' ? !id(body.variantId) || !uuid(body.locationId) || body.itemId !== undefined
      : !uuid(body.itemId) || body.variantId !== undefined || (body.action === 'move' ? !uuid(body.locationId) : body.locationId !== undefined)) throw fail('INVALID_COMMAND');
    return { action: body.action, variantId: body.variantId, itemId: body.itemId, locationId: body.locationId, quantity: body.quantity };
  }
  async function addBatch(uid,body) {
    const { requestId,generation,rows }=body;
    if (!uuid(requestId) || typeof generation!=='string' || !/^(0|[1-9]\d{0,18})$/.test(generation)
      || !Array.isArray(rows) || rows.length<1 || rows.length>1000) throw fail('INVALID_COMMAND');
    const normalized=rows.map(row=>({
      variantId:row?.variantId,quantity:row?.quantity,
      location:typeof row?.location==='string'?row.location.normalize('NFC').trim():'',
    }));
    const fingerprint=createHash('sha256').update(JSON.stringify(['add-batch',generation,normalized])).digest('hex');
    return db.withUser(uid,async client=>{
      await lockSubject(client,uid);
      const prior=(await client.query('select fingerprint,result from app.inventory_operations where request_id=$1',[requestId])).rows[0];
      if (prior) {
        if (prior.fingerprint!==fingerprint) throw fail('IDEMPOTENCY_CONFLICT',409);
        return {...prior.result,replayed:true};
      }
      const state=await requireRegistered(client,uid);
      checkGeneration(state.generation,generation);
      const ids=[...new Set(normalized.map(row=>row.variantId).filter(id))];
      const variants=new Set((await client.query(
        'select id::text from catalog.printing_variants where id=any($1::bigint[]) and is_active',[ids])).rows.map(row=>row.id));
      const stored=(await client.query(`
        select i.variant_id::text as "variantId",s.name as location,i.quantity::text
        from app.inventory_items i join app.storage_locations s on s.id=i.location_id
        where i.user_id=$1 and i.import_key is null and i.variant_id=any($2::bigint[])
          and s.name=any($3::text[])`,[uid,ids,[...new Set(normalized.map(row=>row.location).filter(name=>!name.includes('\0')))]] )).rows;
      const keyOf=row=>JSON.stringify([row.variantId,row.location]);
      const quantities=new Map(stored.map(row=>[keyOf(row),BigInt(row.quantity)]));
      const additions=new Map();
      const operationResults=normalized.map((row,requestIndex)=>{
        const rejected=failReason=>({requestIndex,status:'fail',failReason,qty:0});
        if (!variants.has(row.variantId)) return rejected('invalid_no');
        if (!row.location || row.location.length>80 || row.location.includes('\0')) return rejected('no_loc');
        if (!Number.isSafeInteger(row.quantity) || row.quantity<1) return rejected('invalid_qty');
        const key=keyOf(row), total=(quantities.get(key)??0n)+BigInt(row.quantity);
        if (total>BigInt(Number.MAX_SAFE_INTEGER)) return rejected('invalid_qty');
        quantities.set(key,total);
        additions.set(key,{...row,quantity:(additions.get(key)?.quantity??0)+row.quantity});
        return {requestIndex,status:'success',qty:row.quantity};
      });
      const result={fromRevision:state.revision,revision:state.revision,locations:[],changed:[],operationResults};
      if (additions.size) {
        const updates=[...additions.values()], names=[...new Set(updates.map(row=>row.location))];
        const added=await ensureInventoryLocations(client,uid,names);
        result.locations=(await client.query('select id,name,position from app.storage_locations where user_id=$1 and name=any($2::text[]) order by position,id',[uid,names])).rows;
        const written=await client.query(`
          insert into app.inventory_items(user_id,variant_id,location_id,quantity)
          select $1,i."variantId",s.id,i.quantity
          from jsonb_to_recordset($2::jsonb) as i("variantId" bigint,location text,quantity bigint)
          join app.storage_locations s on s.user_id=$1 and s.name=i.location
          on conflict(user_id,variant_id,location_id) where variant_id is not null and import_key is null
          do update set quantity=app.inventory_items.quantity+excluded.quantity returning id`,[uid,JSON.stringify(updates)]);
        if(written.rowCount!==updates.length) throw fail('SERVICE_UNAVAILABLE',503);
        result.changed=await items(client,written.rows.map(row=>row.id));
        const head=await client.query(`
          update app.inventory_heads set revision=revision+1,next_location_number=next_location_number+$2
          where user_id=$1 returning revision::text`,[uid,added.length]);
        result.revision=head.rows[0].revision;
      }
      await client.query('insert into app.inventory_operations(user_id,request_id,fingerprint,result) values($1,$2,$3,$4)',[uid,requestId,fingerprint,result]);
      return result;
    });
  }
  async function command(uid, body, generation) {
    const input = validateCommand(body);
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return db.withUser(uid, async client => {
      await lockSubject(client, uid);
      const state = await requireRegistered(client, uid);
      const prior = (await client.query('select fingerprint,result from app.inventory_operations where request_id=$1', [body.requestId])).rows[0];
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw fail('IDEMPOTENCY_CONFLICT', 409);
        return { ...prior.result, replayed: true };
      }
      checkGeneration(state.generation, generation);
      const touched = new Set();
      let source;
      if (input.action !== 'add') {
        source = (await client.query('select * from app.inventory_items where id=$1 for update', [input.itemId])).rows[0];
        if (!source) throw fail('NOT_FOUND', 404);
        if (BigInt(source.quantity) < BigInt(input.quantity)) throw fail('INSUFFICIENT_QUANTITY', 409);
        if (input.action === 'move' && source.location_id === input.locationId) throw fail('SAME_LOCATION');
        touched.add(source.id);
      }
      if (input.action !== 'discard') {
        const location = await client.query('select id from app.storage_locations where id=$1', [input.locationId]);
        if (!location.rowCount) throw fail('LOCATION_NOT_FOUND', 404);
        const variantId = input.action === 'add' ? input.variantId : source.variant_id;
        if (input.action === 'add') {
          const variant = await client.query('select id from catalog.printing_variants where id=$1 and is_active', [variantId]);
          if (!variant.rowCount) throw fail('VARIANT_UNAVAILABLE', 409);
        }
        const target = source?.import_key ? (await client.query(`
          insert into app.inventory_items(user_id,variant_id,location_id,quantity,unresolved_details,import_key,import_details)
          values($1,$2,$3,$4,$5,$6,$7) on conflict(user_id,location_id,import_key) where import_key is not null
          do update set quantity=app.inventory_items.quantity+excluded.quantity returning id`,
          [uid,variantId,input.locationId,input.quantity,source.unresolved_details,source.import_key,source.import_details])).rows[0]
          : variantId===null ? (await client.query(`insert into app.inventory_items(user_id,variant_id,location_id,quantity,unresolved_details)
          values($1,null,$2,$3,$4) returning id`,[uid,input.locationId,input.quantity,source.unresolved_details])).rows[0] : (await client.query(`insert into app.inventory_items(user_id,variant_id,location_id,quantity)
          values($1,$2,$3,$4) on conflict(user_id,variant_id,location_id) where variant_id is not null and import_key is null
          do update set quantity=app.inventory_items.quantity+excluded.quantity returning id`, [uid,variantId,input.locationId,input.quantity])).rows[0];
        touched.add(target.id);
      }
      if (source) {
        if (BigInt(source.quantity) === BigInt(input.quantity)) await client.query('delete from app.inventory_items where id=$1', [source.id]);
        else await client.query('update app.inventory_items set quantity=quantity-$2 where id=$1', [source.id,input.quantity]);
      }
      const { rows: [{ revision }] } = await client.query(`
        update app.inventory_heads set revision=revision+1 where user_id=$1 and state='active' returning revision::text`, [uid]);
      const changed = await items(client, [...touched]);
      const deleted = [...touched].filter(value => !changed.some(item => item.id === value));
      const result = { requestId: body.requestId, revision, changed, deleted, summary: await summary(client) };
      await client.query('insert into app.inventory_operations(user_id,request_id,fingerprint,result) values($1,$2,$3,$4)', [uid,body.requestId,fingerprint,result]);
      return result;
    });
  }
  async function preferences(uid,patch){
    if(!patch||Object.keys(patch).some(k=>!['theme','isDetailMode','hideMembershipVerify','readNotices','onboarding'].includes(k))||('theme'in patch&&!['light','dark'].includes(patch.theme))||['isDetailMode','hideMembershipVerify'].some(k=>k in patch&&typeof patch[k]!=='boolean'))throw fail('INVALID_COMMAND');
    if ('readNotices' in patch && (!Array.isArray(patch.readNotices) || patch.readNotices.length > 8 || patch.readNotices.some(id => typeof id !== 'string' || !/^\d{4}\.\d{2}\.\d{2}T\d{2}:\d{2}$/.test(id)))) throw fail('INVALID_COMMAND');
    if ('onboarding' in patch && (!patch.onboarding || typeof patch.onboarding !== 'object' || Array.isArray(patch.onboarding) || Object.keys(patch.onboarding).some(page => !['home','add','move','discard','inventory'].includes(page) || typeof patch.onboarding[page] !== 'boolean'))) throw fail('INVALID_COMMAND');
    return db.withUser(uid, async client => {
      await lockSubject(client, uid);
      await requireRegistered(client, uid);
      await client.query('insert into app.user_profiles(user_id) values($1) on conflict do nothing', [uid]);
      await client.query('insert into app.user_preferences(user_id) values($1) on conflict do nothing', [uid]);
      return (await client.query(`update app.user_preferences set theme=coalesce($1,theme),is_detail_mode=coalesce($2,is_detail_mode),hide_membership_verify=coalesce($3,hide_membership_verify),
      read_notices=ARRAY(select id from unnest(coalesce($4::text[],'{}'::text[]) || read_notices) with ordinality as marked(id,position) group by id order by min(position) limit 8),onboarding=onboarding || coalesce($5::jsonb,'{}'::jsonb)
      returning theme,is_detail_mode as "isDetailMode",hide_membership_verify as "hideMembershipVerify",read_notices as "readNotices",onboarding`,[patch.theme??null,patch.isDetailMode??null,patch.hideMembershipVerify??null,patch.readNotices??null,patch.onboarding?JSON.stringify(patch.onboarding):null])).rows[0];
    });
  }
  async function nickname(uid, value) {
    if (typeof value !== 'string' || !value.trim() || Array.from(value.trim()).length > 20) throw fail('INVALID_COMMAND');
    return db.withUser(uid, async client => {
      await lockSubject(client, uid);
      await requireRegistered(client, uid);
      const { rows: [profile] } = await client.query(`
        insert into app.user_profiles(user_id,nickname) values($1,$2)
        on conflict(user_id) do update set nickname=excluded.nickname returning nickname`, [uid,value.trim()]);
      return profile;
    });
  }
  return {prepareLoginRead,loginView, preferences,nickname,bootstrap, createDemo, search,catalog: catalogDetails, card, registrationCards,inventoryCardBatches, findPackSuggestions,findPacks,packCards,addLocation, command,addBatch,
    registrationStatus, membershipWriteGate, membershipStatus, completeRegistration, importStatus, inventoryGeneration, clearInventory, reserveImport, importInventory };
}
module.exports = { createRepository, fail, randomUUID };
