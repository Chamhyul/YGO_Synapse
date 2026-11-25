'use strict';
const model=require('../../public/backend/inventory-state.js');
// 고정 SQL만 재사용하며 사용자 행·권한 결과를 보관하지 않는다.
const queries={
  cards:`select c.cid::text,null::text as name,c.card_type as type,c.atk,c.def,c.properties,c.lv,c.attribute,c.race,c.pendulum_scale as "pendulumScale",c.revision::text from catalog.cards c where c.cid=any($1::integer[]) order by c.cid`,
  printings:`select p.cid::text,p.id::text,p.pid,p.locale,p.number,p.number_status as "numberStatus",pk.name as "packName",pk.reported_card_count as "reportedCardCount" from catalog.card_printings p join catalog.packs pk on pk.pid=p.pid and pk.locale=p.locale where p.id=any($2::bigint[]) order by p.locale,p.id`,
  sources:`select s.cid::text,s.id::text,s.locale,s.official_ciid as ciid,s.artwork_id::text as "groupId",s.image_ciid as "imageCiid",s.image_variant as "imageVariant",exists(select from catalog.printing_variants v where v.artwork_source_id=s.id and v.is_active) as released from catalog.artwork_sources s where s.cid=any($1::integer[]) order by s.id`,
  localizations:`select cid::text,locale,name from catalog.card_localizations where cid=any($1::integer[]) order by cid,locale`,
  rarities:`select r.id::text,r.display_code as "displayCode",r.sort_order as "sortOrder",coalesce(jsonb_object_agg(l.locale,l.label) filter(where l.label is not null),'{}') as labels,coalesce(jsonb_object_agg(l.locale,l.display_code) filter(where l.display_code is not null),'{}') as "displayCodes" from catalog.rarities r left join catalog.rarity_labels l on l.rarity_id=r.id and l.is_preferred where r.id=any($3::bigint[]) group by r.id order by r.sort_order,r.id`,
  numbers:`select cid::text,number,count(*)::text as count from catalog.card_printings where cid=any($1::integer[]) and number is not null group by cid,number order by cid,number`,
 };
const columns=Object.entries(queries).map(([name,sql])=>`(select coalesce(json_agg(json_build_array(${model.columns[name].map(key=>'row."'+key+'"').join(',')})),'[]'::json) from (${sql}) row) as ${name}`);
const catalogSql='select '+columns.join(',');
const nameColumn=model.columns.cards.indexOf('name');
async function projectLogin(client,data,locale,{timing=(_name,work)=>work()}={}){
 const ids=[...new Set(data.items.map(i=>i.cid).filter(Boolean))],printingIds=[...new Set(data.items.map(i=>i.printingId).filter(Boolean))],rarityIds=[...new Set(data.items.map(i=>i.rarityId).filter(Boolean))];
 const catalog=ids.length ? (await timing('db_catalog_sql',()=>client.query(catalogSql,[ids,printingIds,rarityIds]))).rows[0] : Object.fromEntries(Object.keys(model.columns).map(key=>[key,[]]));
 // localizations는 기존 SQL의 cid·locale 순서다. 첫 언어를 대체값으로 쓰고 요청 언어가 있으면 우선한다.
 // 빈 이름도 유효하며, 언어 행이 없을 때만 기존 LEFT JOIN과 같은 null을 유지한다.
 const names=new Map();
 for(const [cid,language,name] of catalog.localizations)if(!names.has(cid)||language===locale)names.set(cid,name);
 for(const card of catalog.cards)card[nameColumn]=names.get(card[0])??null;
 return {version:1,rulesVersion:1,complete:true,locale,profile:data.profile,hasProfile:data.hasProfile,inventoryState:data.inventoryState,generation:data.generation,
  preferences:data.preferences||{},locations:data.locations,items:data.items,itemCount:data.items.length,summary:data.summary,catalog};
}
module.exports={projectLogin};
