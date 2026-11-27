/* Firebase 사용자 상태와 공개 카드 캐시의 수명을 분리한 단일 저장소. */
(function(root,factory){const value=factory();if(typeof module==='object'&&module.exports)module.exports=value;else root.YgoInventoryState=value;})(typeof globalThis==='object'?globalThis:this,function(){
 'use strict';
 const locales=['ko','ja','ae','cn','en','de','fr','it','es','pt'];
 const columns={cards:['cid','name','type','atk','def','properties','lv','attribute','race','pendulumScale','revision'],
  printings:['cid','id','pid','locale','number','numberStatus','packName','reportedCardCount'],
  sources:['cid','id','locale','ciid','groupId','imageCiid','imageVariant','released'],
  localizations:['cid','locale','name'],rarities:['id','displayCode','sortOrder','labels','displayCodes'],numbers:['cid','number','count']};
 const fail=()=>{throw Error('초기 보유 자료를 확인하지 못했습니다.');};
 const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v),identifier=v=>typeof v==='string'&&v.length>0&&v.length<=512;
 const nullableText=v=>v===null||typeof v==='string';
 const positive=v=>Number.isSafeInteger(v)&&v>0;
 const decimal=v=>typeof v==='string'&&/^(0|[1-9]\d{0,39})$/.test(v);
 function unpack(name,rows){if(!Array.isArray(rows))fail();return rows.map(row=>{if(!Array.isArray(row)||row.length!==columns[name].length)fail();return Object.fromEntries(columns[name].map((key,i)=>[key,row[i]]));});}
 function pack(name,rows){return rows.map(row=>columns[name].map(key=>row[key]??null));}
 function groupSources(rows){const result=new Map();for(const source of rows){const id=source.groupId||'source:'+source.id,key=source.cid+':'+id;if(!result.has(key))result.set(key,{cid:source.cid,id,locales:[],sources:[]});const art=result.get(key);art.sources.push(source);if(source.released&&!art.locales.includes(source.locale))art.locales.push(source.locale);}return [...result.values()];}
 function validate(view,uid){
  if(!object(view)||view.version!==1||view.rulesVersion!==1||view.complete!==true||!locales.includes(view.locale)
   ||!object(view.profile)||view.profile.userId!==uid||!decimal(view.profile.revision)||!decimal(view.generation)
   ||!['missing','active','deleted'].includes(view.inventoryState)||typeof view.hasProfile!=='boolean'
   ||!object(view.preferences)||!object(view.summary)||!decimal(view.summary.quantity)
   ||!Array.isArray(view.items)||view.itemCount!==view.items.length||!Array.isArray(view.locations)||!object(view.catalog))fail();
  const locations=new Map();for(const l of view.locations){if(!object(l)||!identifier(l.id)||typeof l.name!=='string'||locations.has(l.id))fail();locations.set(l.id,l);}
  const decoded=Object.fromEntries(Object.keys(columns).map(key=>[key,unpack(key,view.catalog[key])])),cards=new Map(),printings=new Map(),sources=new Map(),rarities=new Map();
  for(const c of decoded.cards){if(!/^[1-9]\d{0,9}$/.test(c.cid)||cards.has(c.cid)||!nullableText(c.name)||!decimal(c.revision)||(c.properties!==null&&(!Array.isArray(c.properties)||c.properties.some(p=>typeof p!=='string'))))fail();cards.set(c.cid,c);}
  for(const p of decoded.printings){if(!cards.has(p.cid)||!identifier(p.id)||printings.has(p.id)||!locales.includes(p.locale)||typeof p.packName!=='string'||!nullableText(p.number)||!['known','not_assigned','unverified'].includes(p.numberStatus)
    ||(p.numberStatus==='known'?!p.number:p.number!==null))fail();printings.set(p.id,p);}
  for(const s of decoded.sources){if(!cards.has(s.cid)||!identifier(s.id)||sources.has(s.id)||!locales.includes(s.locale)||typeof s.released!=='boolean'||!positive(s.ciid)||(s.imageCiid!==null&&!positive(s.imageCiid))||!nullableText(s.imageVariant)||(s.groupId!==null&&!identifier(s.groupId)))fail();sources.set(s.id,s);}
  for(const r of decoded.rarities){if(!identifier(r.id)||rarities.has(r.id)||!object(r.labels)||!object(r.displayCodes)||Object.values(r.labels).some(v=>typeof v!=='string')||Object.values(r.displayCodes).some(v=>typeof v!=='string'))fail();rarities.set(r.id,r);}
  const numbers=new Set(),localized=new Set();
  for(const n of decoded.numbers){const key=JSON.stringify([n.cid,n.number]);if(!cards.has(n.cid)||typeof n.number!=='string'||!decimal(n.count)||BigInt(n.count)<1n||numbers.has(key))fail();numbers.add(key);}
  for(const l of decoded.localizations){const key=l.cid+':'+l.locale;if(!cards.has(l.cid)||!locales.includes(l.locale)||typeof l.name!=='string'||localized.has(key))fail();localized.add(key);}
  for(const p of printings.values())if(p.number!==null&&!numbers.has(JSON.stringify([p.cid,p.number])))fail();
  const items=new Set(),ownedCids=new Set(),ownedPrintings=new Set(),variants=new Map();let quantity=0n;for(const item of view.items){
   if(!object(item)||!identifier(item.id)||items.has(item.id)||!locations.has(item.locationId)||!decimal(item.quantity)||BigInt(item.quantity)>BigInt(Number.MAX_SAFE_INTEGER))fail();items.add(item.id);quantity+=BigInt(item.quantity);
   if(item.quantity==='0'||typeof item.name!=='string'||typeof item.locationName!=='string'||item.locationName!==locations.get(item.locationId).name
    ||(item.importDetails!=null&&(!object(item.importDetails)||Object.values(item.importDetails).some(v=>v!=null&&typeof v!=='string'))))fail();
   if(item.cid!==null&&item.cid!==undefined){if(!cards.has(item.cid)||!identifier(item.variantId)||!printings.has(item.printingId)||!sources.has(item.artworkSourceId)||!rarities.has(item.rarityId)||typeof item.isActive!=='boolean')fail();ownedCids.add(item.cid);}
   if(item.printingId!=null&&(!printings.has(item.printingId)||printings.get(item.printingId).cid!==item.cid))fail();
   if(item.artworkSourceId!=null&&(!sources.has(item.artworkSourceId)||sources.get(item.artworkSourceId).cid!==item.cid))fail();
   if(item.rarityId!=null&&!rarities.has(item.rarityId))fail();
   if(item.printingId!=null)ownedPrintings.add(item.printingId);
   if(item.artworkSourceId!=null){const source=sources.get(item.artworkSourceId);if(item.artworkId!==(source.groupId||'source:'+source.id)||item.sourceCiid!==source.ciid)fail();}
   if(item.variantId!=null){const signature=JSON.stringify([item.cid,item.printingId,item.artworkSourceId,item.rarityId]);if(variants.has(item.variantId)&&variants.get(item.variantId)!==signature)fail();variants.set(item.variantId,signature);} 
   if(item.userId!==undefined&&item.userId!==uid)fail();
  }
  if(ownedCids.size!==cards.size||view.summary.quantity!==String(quantity)||view.summary.entries!==items.size||view.summary.printings!==ownedPrintings.size||(view.inventoryState!=='active'&&items.size))fail();
  return {view,decoded};
 }
 function projectedCards(candidate){
  const{view,decoded}=candidate,arts=groupSources(decoded.sources),result=[];
  const byCid=rows=>{const map=new Map();for(const row of rows){if(!map.has(row.cid))map.set(row.cid,[]);map.get(row.cid).push(row);}return map;};
  const printed=byCid(decoded.printings),localized=byCid(decoded.localizations),illustrated=byCid(arts),usage=byCid(decoded.numbers),owned=byCid(view.items),rare=new Map(decoded.rarities.map(r=>[r.id,r]));
  for(const selected of decoded.cards){
   const printings=printed.get(selected.cid)||[],variants=new Map();
   for(const item of owned.get(selected.cid)||[])if(item.variantId!=null)variants.set(item.variantId,{cid:item.cid,id:item.variantId,printingId:item.printingId,rarityId:item.rarityId,artworkId:item.artworkId,artworkSourceId:item.artworkSourceId,rarity:item.rarity,displayCode:null,sourceCiid:item.sourceCiid});
   const rarityIds=new Set([...variants.values()].map(v=>v.rarityId));
   result.push({...selected,inventoryOnly:true,projectionOnly:true,localizations:localized.get(selected.cid)||[],
    printings,variants:[...variants.values()],artworks:illustrated.get(selected.cid)||[],rarities:[...rarityIds].map(id=>rare.get(id)),
    numberUsage:usage.get(selected.cid)||[]});
  }
  return result;
 }
 function create(){
  let sequence=0,privateState={profile:null,generation:null,inventoryState:'missing',hasProfile:false,preferences:{},account:null},locations=new Map(),locationOrder=[],memo;
  const root={session:{uid:null,epoch:0,phase:'signed_out'},inventory:{items:null,locations,locationOrder},catalog:{cards:new Map()},readView:null};
  const changed=()=>{sequence++;memo=undefined;};
  class EntityMap extends Map{set(k,v){super.set(k,Object.freeze(v));changed();return this;}delete(k){const done=super.delete(k);if(done)changed();return done;}clear(){if(this.size){super.clear();changed();}}}
  root.inventory.items=new EntityMap();
  const aliases={};for(const key of ['profile','generation','inventoryState','hasProfile','preferences','account'])Object.defineProperty(aliases,key,{get:()=>privateState[key],set:value=>{privateState[key]=key==='profile'&&value?new Proxy(value,{set:(target,k,v)=>{target[k]=v;changed();return true;}}):value;changed();}});
  Object.defineProperties(aliases,{items:{get:()=>root.inventory.items,set:value=>{root.inventory.items=new EntityMap(value);changed();}},locations:{get:()=>root.inventory.locationOrder.map(id=>root.inventory.locations.get(id)),set:value=>{root.inventory.locations=new Map(value.map(l=>[l.id,l]));root.inventory.locationOrder=value.map(l=>l.id);changed();}}});
  function commit(value){for(const key of ['profile','generation','preferences','account','inventoryState','hasProfile'])if(value[key]!==undefined)aliases[key]=value[key];aliases.items=new Map(value.items.map(i=>[i.id,i]));aliases.locations=value.locations;root.session.uid=value.profile.userId;changed();}
  function clear(){root.session.epoch++;root.session.uid=null;root.session.phase='signed_out';root.inventory.items.clear();aliases.locations=[];aliases.profile=null;aliases.account=null;aliases.preferences={};aliases.generation=null;aliases.inventoryState='missing';aliases.hasProfile=false;root.readView=null;changed();}
  function cached(key,build){if(memo?.key===key&&memo.sequence===sequence)return memo.value;const value=build();memo={key,sequence,value};return value;}
  return {root,aliases,commit,clear,changed,cached,get sequence(){return sequence;}};
 }
 return Object.freeze({locales,columns,pack,unpack,validate,projectedCards,groupSources,create});
});
