'use strict';
const {clean}=require('./parser.cjs');
const {pendingReleases}=require('./release.cjs');
const {correctPrintingNumber}=require('./number-corrections.cjs');
function corrected(snapshot,corrections){
 const value=structuredClone({...snapshot,files:undefined});
 for(const page of value.pages)for(const row of [...page.rows,...(page.pendingRows||[])]){
  row.number=correctPrintingNumber({cid:snapshot.cid,locale:page.locale,pid:row.pid,number:row.number});
 }
 const numberMatches=(row,t)=>row.number===(t.number??null)||row.number===correctPrintingNumber({cid:snapshot.cid,locale:t.locale,pid:t.pid,number:t.number??null});
 const commonFields=new Set(['card_type','properties','lv','attribute','race','atk','def','pendulum_scale']);
 for(const c of corrections.filter(c=>Number(c.target.cid)===snapshot.cid)){
  const t=c.target;
  if(c.operation==='set_field'){
   if(commonFields.has(t.field))for(const page of value.pages)page.common[t.field]=c.value;
   else if(['name','text','text_pen'].includes(t.field)){const page=value.pages.find(p=>p.locale===t.locale);if(page)page.localized[t.field]=c.value;}
   else if(t.field==='number')for(const page of value.pages.filter(p=>p.locale===t.locale))for(const row of [...page.rows,...(page.pendingRows||[])].filter(r=>r.pid===t.pid&&numberMatches(r,t))){row.number=c.value==null?null:clean(c.value).toUpperCase();row.numberStatus=row.number?'known':row.status==='awaiting_release'?'unverified':'not_assigned';}
   else throw Error('UNSUPPORTED_CORRECTION_FIELD');
  }
  if(c.operation==='hide_variant')for(const page of value.pages)for(const field of ['rows','pendingRows'])if(page[field])page[field]=page[field].filter(r=>!(r.locale===t.locale&&r.pid===t.pid&&numberMatches(r,t)&&(!t.rarityLabel||r.rarityLabel===t.rarityLabel)&&(!t.ciid||r.ciid===t.ciid)));
  if(c.operation==='add_variant'){
   const page=value.pages.find(p=>p.locale===t.locale);if(!page)continue;
   const reference=page.rows.find(r=>r.pid===t.pid&&numberMatches(r,t));
   if(!reference)throw Error('CORRECTION_PRINTING_NOT_FOUND');
   page.rows.push({...reference,...c.value,cid:snapshot.cid,locale:t.locale,pid:t.pid,number:reference.number});
  }
 }
 return value;
}
async function writeSnapshot(pool,snapshot,{verify=false}={}){
 const client=await pool.connect();try{
  await client.query('begin');await client.query('select pg_advisory_xact_lock($1)',[snapshot.cid]);
  const corrections=(await client.query("select target,operation,value from catalog.catalog_corrections where enabled and target->>'cid'=$1 order by id",[String(snapshot.cid)])).rows;
  const value=corrected(snapshot,corrections),priority=['en','ja','ko','ae','cn','de','fr','it','es','pt'];
  const best=[...value.pages].sort((a,b)=>priority.indexOf(a.locale)-priority.indexOf(b.locale))[0],common=best.common;
  const existingLocales=(await client.query('select locale from catalog.card_localizations where cid=$1',[value.cid])).rows;
  const updateCommon=existingLocales.every(p=>priority.indexOf(p.locale)>=priority.indexOf(best.locale));
  await client.query(`insert into catalog.cards(cid,card_type,properties,lv,attribute,race,atk,def,pendulum_scale)
   values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(cid) do update set card_type=case when $10 then excluded.card_type else catalog.cards.card_type end,
   properties=case when $10 then excluded.properties else catalog.cards.properties end,lv=case when $10 then excluded.lv else catalog.cards.lv end,
   attribute=case when $10 then excluded.attribute else catalog.cards.attribute end,race=case when $10 then excluded.race else catalog.cards.race end,
   atk=case when $10 then excluded.atk else catalog.cards.atk end,def=case when $10 then excluded.def else catalog.cards.def end,
   pendulum_scale=case when $10 then excluded.pendulum_scale else catalog.cards.pendulum_scale end,updated_at=now(),revision=catalog.cards.revision+1`,
   [value.cid,common.card_type,common.properties??null,common.lv??null,common.attribute??null,common.race??null,common.atk??null,common.def??null,common.pendulum_scale??null,updateCommon]);
  const sourceIds=new Map();
  for(const page of value.pages)for(const ciid of new Set([...(page.localized.ciid||[]),...page.rows.map(r=>r.ciid)].filter(n=>Number.isInteger(n)&&n>0))){
   const source=(await client.query(`insert into catalog.artwork_sources(cid,locale,official_ciid) values($1,$2,$3)
    on conflict(cid,locale,official_ciid) do update set official_ciid=excluded.official_ciid returning id`,[value.cid,page.locale,ciid])).rows[0];
   sourceIds.set(page.locale+':'+ciid,source.id);
  }
  if(corrections.some(c=>c.operation==='map_artwork'))throw Error('ARTWORK_MAPPING_REQUIRES_MANUAL_SOURCE_EDIT');
  let count=0;const expected=new Set();
  const rareCache=new Map();
  for(const page of value.pages){
   await client.query(`insert into catalog.card_localizations(cid,locale,name,card_text,pendulum_text) values($1,$2,$3,$4,$5)
    on conflict(cid,locale) do update set name=excluded.name,card_text=excluded.card_text,pendulum_text=excluded.pendulum_text`,[value.cid,page.locale,page.localized.name,page.localized.text??null,page.localized.text_pen??null]);
   // 미발매 불완전 팩의 기존 확정 조합은 보존한다. 결측 정보로 기존 정보를 지우지 않는다.
   const pendingPids=[...new Set((page.pendingRows||[]).map(r=>r.pid))];
   if(pendingPids.length){
    const preserved=(await client.query(`select p.pid,p.locale,p.number,p.number_status,v.rarity_id::text,v.artwork_source_id::text from catalog.printing_variants v join catalog.card_printings p on p.id=v.printing_id where p.cid=$1 and p.locale=$2 and p.pid=any($3::text[]) and v.is_active`,[value.cid,page.locale,pendingPids])).rows;
    for(const r of preserved)expected.add(JSON.stringify([r.pid,r.locale,r.number,r.number_status,r.rarity_id,r.artwork_source_id]));
   }
   await client.query('update catalog.printing_variants v set is_active=false from catalog.card_printings p where p.id=v.printing_id and p.cid=$1 and p.locale=$2 and not(p.pid=any($3::text[]))',[value.cid,page.locale,pendingPids]);
   const printingCache=new Map();
   for(const row of [...page.rows,...(page.pendingRows||[])]){
    const pkey=row.pid+':'+row.numberStatus+':'+row.number;
    let printingId=printingCache.get(pkey);
    if(!printingId){
     await client.query(`insert into catalog.packs(pid,locale,name) values($1,$2,$3) on conflict(pid,locale) do update set name=excluded.name,updated_at=now()`,[row.pid,row.locale,row.packName]);
     await client.query(`insert into catalog.pack_cards(pid,locale,cid) values($1,$2,$3) on conflict(pid,locale,cid) do nothing`,[row.pid,row.locale,value.cid]);
     const existing=(await client.query(`select id from catalog.card_printings where cid=$1 and pid=$2 and locale=$3 and number is not distinct from $4 and number_status=$5`,[value.cid,row.pid,row.locale,row.number,row.numberStatus])).rows[0];
     printingId=existing?.id||(await client.query(`insert into catalog.card_printings(cid,pid,locale,number,number_status) values($1,$2,$3,$4,$5) returning id`,[value.cid,row.pid,row.locale,row.number,row.numberStatus])).rows[0].id;
     printingCache.set(pkey,printingId);
    }
    // 확인된 번호·팩 관계까지만 저장한다. 레어도/그림 조합은 추정해서 만들지 않는다.
    if(row.status==='awaiting_release')continue;
    const rkey=row.locale+':'+row.rarityLabel;let rarityId=rareCache.get(rkey);
    if(!rarityId){
     const matches=(await client.query('select distinct rarity_id from catalog.rarity_labels where locale=$1 and (($2::integer is not null and official_rid=$2) or normalize(label,NFKC)=normalize($3,NFKC))',[row.locale,row.officialRid,row.rarityLabel])).rows;
     if(matches.length>1)throw Error('AMBIGUOUS_RARITY_LABEL');
     rarityId=matches[0]?.rarity_id;
     // DP만으로는 QCSE·UR 등의 별도 사양을 구분할 수 없다. 공식 RID와 DP가
     // 함께 같고 사전의 대상이 하나일 때만 다른 언어 명칭을 같은 ID에 누적한다.
     if(!rarityId&&row.officialRid!=null){
      const shared=(await client.query('select distinct rarity_id from catalog.rarity_labels where official_rid=$1 and display_code=$2',[row.officialRid,row.displayCode])).rows;
      if(shared.length>1)throw Error('RARITY_DICTIONARY_REVIEW_REQUIRED');rarityId=shared[0]?.rarity_id;
     }
     if(!rarityId)rarityId=(await client.query('insert into catalog.rarities(display_code,sort_order) values($1,$2) returning id',[row.displayCode,row.officialRid??1000])).rows[0].id;
     await client.query(`insert into catalog.rarity_labels(rarity_id,locale,label,is_preferred,display_code,official_rid)
      values($1,$2,$3,not exists(select from catalog.rarity_labels where rarity_id=$1 and locale=$2 and is_preferred),$4,$5)
      on conflict(rarity_id,locale,label) do update set display_code=coalesce(catalog.rarity_labels.display_code,excluded.display_code),official_rid=coalesce(catalog.rarity_labels.official_rid,excluded.official_rid)`,[rarityId,row.locale,row.rarityLabel,row.displayCode,row.officialRid]);
     rareCache.set(rkey,rarityId);
    }
    const sourceId=sourceIds.get(row.locale+':'+row.ciid);if(!sourceId)throw Error('CRAWL_ARTWORK_UNRESOLVED');
    expected.add(JSON.stringify([row.pid,row.locale,row.number,row.numberStatus,String(rarityId),String(sourceId)]));
    await client.query(`insert into catalog.printing_variants(printing_id,rarity_id,artwork_source_id,is_active) values($1,$2,$3,true)
     on conflict(printing_id,rarity_id,artwork_source_id) do update set is_active=true`,[printingId,rarityId,sourceId]);count++;
   }
  }
  if(verify){const actual=(await client.query(`select p.pid,p.locale,p.number,p.number_status,v.rarity_id::text,v.artwork_source_id::text from catalog.printing_variants v join catalog.card_printings p on p.id=v.printing_id where p.cid=$1 and p.locale=any($2::text[]) and v.is_active`,[value.cid,value.pages.map(p=>p.locale)])).rows;
   const keys=new Set(actual.map(r=>JSON.stringify([r.pid,r.locale,r.number,r.number_status,r.rarity_id,r.artwork_source_id])));
   if(keys.size!==expected.size||[...expected].some(k=>!keys.has(k)))throw Error('STORED_VARIANT_VERIFICATION_FAILED');}
  await client.query('commit');return {cid:value.cid,locales:value.pages.length,sourceRows:count,storedVariants:expected.size,officialSources:sourceIds.size,corrections:corrections.length,verified:verify,pendingReleases:pendingReleases(value)};
 }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}
module.exports={writeSnapshot,corrected};
