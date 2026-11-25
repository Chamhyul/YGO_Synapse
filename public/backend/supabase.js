/* public의 기본 데이터 연결. 미연결 기능은 기존 구현을 보존하고 API 폴백 없이 안내한다. */
(function (root) {
'use strict';
const directLoginOrigin='https://ygo-supabase-production-e4pt3uwcya-du.a.run.app';
const client=(()=>{
 function measureLoginStage(name,work,operation='login'){
 const timing=(typeof root==='undefined'?globalThis:root).YgoLoginTiming?.request(operation);
 return timing ? timing.measure(name,work) : work();
}
 const sessionKey='synapse-sql-ui-session';
 const store=root.YgoInventoryState.create();
 const state={token:sessionStorage.getItem(sessionKey),summaries:new Map(),ready:null,auth:null,pending:new Map()};
 for(const key of ['items','locations','profile','generation','preferences','account','inventoryState','hasProfile'])Object.defineProperty(state,key,{get:()=>store.aliases[key],set:value=>{store.aliases[key]=value;}});
 Object.defineProperty(state,'cards',{get:()=>[...store.root.catalog.cards.values()],set:cards=>{store.root.catalog.cards=new Map(cards.map(card=>[String(card.cid),card]));store.changed();}});
 const putCard=card=>{store.root.catalog.cards.set(String(card.cid),card);store.changed();};
 let inventoryRefresh = 0, refreshedInventory = 0, snapshotRevision = '0', resetEpoch = 0;
 let membershipRequest;
 const older = (a,b) => BigInt(a) < BigInt(b);
 const locales=['ko','ja','ae','cn','en','de','fr','it','es','pt'];
 const regionNames=['한국','일본','아시아','중국','영어권','독일','프랑스','이탈리아','스페인','포르투갈'];
 const numberCounts = new Map();
 const numberKey = p => p.number && numberCounts.get(p.number) === 1
  ? p.number
  : `${p.number||'번호 없음'} (${p.packName} · ${p.locale})`;
 const printingsByCard=new WeakMap();
 const cardFor=cid=>store.root.catalog.cards.get(String(cid));
 const printingById=(card,id)=>{if(!card)return;let map=printingsByCard.get(card);if(!map){map=new Map(card.printings.map(p=>[p.id,p]));printingsByCard.set(card,map);}return map.get(id);};
 const packNumberKey=p=>`${p.number||'번호 없음'} (${p.packName} · ${p.locale} · ${p.id})`.toUpperCase();
 const matchesNumber=(p,key)=>[numberKey(p),packNumberKey(p)].some(value=>value.toUpperCase()===String(key).toUpperCase());
 const printingFor=(card,key)=>card?.printings.find(p=>matchesNumber(p,key));
 const artworkSlots=new WeakMap();
 function slots(card){
  if(!card)return new Map();const locale=UIStore.currentRegion||'ko';let cache=artworkSlots.get(card);if(cache?.locale===locale)return cache.map;
  const result=new Map(),used=new Set();
  for(const art of card.artworks){const preferred=art.sources.find(s=>s.locale===locale);if(preferred&&!used.has(preferred.ciid)){result.set(art.id,preferred.ciid);used.add(preferred.ciid);}}
  for(const art of card.artworks)if(!result.has(art.id)){const requested=art.sources.find(s=>s.locale==='ja')?.ciid||art.sources[0]?.ciid;let n=requested&&!used.has(requested)?requested:1;while(used.has(n))n++;result.set(art.id,n);used.add(n);}
  artworkSlots.set(card,{locale,map:result});return result;
 }
 const artSlot=(card,v)=>String(slots(card).get(v?.artworkId)||1);
 function requireRegistrationOwner(user){
  if(!user || state.firebaseUser!==user || root.firebase.auth().currentUser!==user)throw Error('서비스 계정이 변경되었습니다.');
 }
 async function api(path,body,{includeToken=true,appCheck,signal,registrationOwner,preparedToken,resultStream}={}){
  if(registrationOwner)requireRegistrationOwner(registrationOwner);
  const firebaseUser=state.firebaseUser;
  const token=registrationOwner ? (preparedToken ?? await awaitApiPreparation(firebaseUser.getIdToken(),signal))
   : includeToken ? (firebaseUser ? await awaitApiPreparation(firebaseUser.getIdToken(),signal) : state.token) : null;
  if(includeToken && firebaseUser!==state.firebaseUser)throw Error('서비스 계정이 변경되었습니다.');
  if(registrationOwner)requireRegistrationOwner(registrationOwner);
  const operation=path.startsWith('registration')?'getRegistrationStatus':/^(bootstrap|catalog\/inventory-batches|catalog\/registration)/.test(path)?'getUserData':null;
  const timing=operation && root.YgoLoginTiming?.request(operation);
  const run=(name,work)=>timing?timing.measure(name,work):work();
  const initialLoginRead=body===undefined && includeToken && registrationOwner && path.startsWith('registration?')
   && new URLSearchParams(path.slice(path.indexOf('?')+1)).get('includeUserData')==='true'
   && new URLSearchParams(path.slice(path.indexOf('?')+1)).get('initialView')==='inventory-v1';
  const direct=initialLoginRead && productionHost && state.auth==='firebase' && state.directLoginRead===true;
  const res=await run('http',()=>fetch((direct?directLoginOrigin:'')+'/api/v2/'+path,{method:body===undefined?'GET':'POST',signal,
   ...(direct?{mode:'cors',credentials:'omit',redirect:'error'}:{}),
   headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(token?{Authorization:'Bearer '+token}:{}),...(appCheck?{'X-Firebase-AppCheck':appCheck}:{}),...(resultStream?{Accept:'application/x-ndjson'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  const value=await run('response_json',()=>res.ok && resultStream ? resultStream.read(res) : res.json());
  if(!res.ok)throw Object.assign(Error(value.message||value.code||'SERVICE_UNAVAILABLE'),{status:res.status,code:value.code});
  return value;
 }
 async function packSuggestions(query,signal){
  const {names}=await api('packs/suggestions?'+new URLSearchParams({q:query}),undefined,{includeToken:false,signal});
  return names;
 }
 function fetchPackPage(packId,locale,offset,signal){
  return api('packs/'+encodeURIComponent(packId)+'/cards?'+new URLSearchParams({locale,offset}),undefined,{signal,includeToken:false});
 }
 function applyAccount(value){
  state.account={accountRole:value.accountRole||'none',membership:value.membership||{status:'unknown'},
   sourceMembership:value.sourceMembership||null,membershipClaims:value.membershipClaims,claimsPending:value.claimsPending};
  UserStore.sourceMembership=state.account.sourceMembership;
  UserStore.settings.membership=state.account.membership;
  applyMembershipStatus(state.account.membership);
 }
 function syncAccountClaims(value,owner){
  const claims=value.membershipClaims;
  if(!claims || claims.status==='not_required'){UserStore.claimsSyncStatus='not_required';return;}
  UserStore.claimsSyncStatus=claims.status==='synced'?'checking':'pending';
  if(claims.status==='synced' && typeof refreshMembershipClaims==='function'){
   const account=state.account;
   Promise.resolve(refreshMembershipClaims(owner,value)).then(ready=>{
    if(owner!==UserStore.user || account!==state.account)return;
    UserStore.claimsSyncStatus=ready?'ready':'pending';
    if(typeof followMembershipClaims==='function')followMembershipClaims(owner);
    if(typeof setInventorySyncStatus==='function')setInventorySyncStatus(UserStore.inventorySyncStatus);
   });
  }else if(typeof followMembershipClaims==='function')followMembershipClaims(owner);
 }
 function prepareMembershipEntry({claimsOnly=false}={}){
  const token=state.token, owner=UserStore.user;
  if(!token || !owner)return;
  if(membershipRequest?.token===token && membershipRequest.owner===owner)return membershipRequest.promise;
  const request={token,owner};
  request.promise=api('membership',undefined,{signal:AbortSignal.timeout(15000)}).then(value=>{
   if(membershipRequest!==request || token!==state.token || owner!==UserStore.user)return;
   applyAccount(value);
   if(!claimsOnly)syncAccountClaims(value,owner);
   return value;
  },error=>{
   if(membershipRequest!==request || token!==state.token || owner!==UserStore.user)return;
   applyAccount({membership:{status:'unknown'}});
   UserStore.claimsSyncStatus='error';
   if(claimsOnly)throw error;
   if(typeof showToast==='function')showToast('멤버십과 계정 권한을 확인하지 못했습니다. 다시 확인해 주세요.','toast-warn');
  }).finally(()=>{
   if(membershipRequest===request)membershipRequest=null;
  });
  membershipRequest=request;
  return request.promise;
 }
 function row(item){const card=cardFor(item.cid),p=printingById(card,item.printingId),raw=item.importDetails;return [raw?.name||item.name,raw?.number||(p?numberKey(p):item.number||'미확인 수록'),raw?.rarity||item.rarityId||item.rarity,Number(item.quantity),item.locationName,raw?.illustration||(item.artworkId?artSlot(card,{artworkId:item.artworkId}):'미확정'),item.cid||'',item.id,item.printingId,item.variantId,item.locationId];}
 function snapshot(){return store.cached(UIStore.currentRegion||'ko',buildSnapshot);}
 function buildSnapshot(){
  const allCards=[],displayLocations=new Map(),rarities={};let amount=0;
  for(const item of state.items.values()){
   const fields=row(item);allCards.push(Object.freeze(fields));amount+=fields[3];
   if(fields[3]>0){
    const loc=String(fields[4]).trim(),number=String(fields[1]).trim().toUpperCase(),rarity=String(fields[2]).trim();
    if(loc){if(!displayLocations.has(loc))displayLocations.set(loc,new Set());displayLocations.get(loc).add(number);}
    if(rarity)rarities[rarity]=(rarities[rarity]||0)+fields[3];
   }
  }
  return {success:true,...state.account,nickname:state.profile?.nickname||state.profile?.userId||'',createdAt:state.profile?.createdAt||null,
   allCards:Object.freeze(allCards),amount,locations:Object.fromEntries(state.locations.map(l=>[l.name,[]])),rarities:{},
   inventoryDisplaySummary:{version:1,amount,locations:Object.fromEntries([...displayLocations].map(([name,numbers])=>[name,[...numbers]])),rarities},
   settings:{...state.preferences,nickname:state.profile?.nickname||state.profile?.userId||'',membership:state.account?.membership||{status:'unknown'}}};
 }
 function receive(value){
  store.commit({...value,account:value.membership?{accountRole:value.accountRole,membership:value.membership,sourceMembership:value.sourceMembership,membershipClaims:value.membershipClaims,claimsPending:value.claimsPending}:state.account});
  snapshotRevision=value.profile.revision;
 }

 function delta(value){
  if(!state.profile || !older(state.profile.revision,value.revision))return;
  if(BigInt(value.revision)>BigInt(state.profile.revision)+1n)inventoryRefresh++;
  for(const id of value.deleted||[])state.items.delete(id);
  for(const item of value.changed||[])state.items.set(item.id,item);
  state.profile.revision=value.revision;snapshotRevision=value.revision;
 }
 function applyImportDelta({ inventoryDelta:change, importedItems }){
  if(!change || !state.profile || state.pending.size || refreshedInventory!==inventoryRefresh
    || change.fromRevision!==state.profile.revision || change.revision!==String(BigInt(change.fromRevision)+1n)
    || !Array.isArray(importedItems) || !Array.isArray(change.items) || !Array.isArray(change.locations)
    || importedItems.length!==change.items.length)return false;
  const locations=new Map(state.locations.map(location=>[location.id,location]));
  for(const location of change.locations)locations.set(location.id,location);
  if(change.items.some(item=>!locations.has(item.locationId)))return false;
  for(const [index,item] of change.items.entries()){
   const original=importedItems[index];
   state.items.set(item.id,{...item,cid:original.cid,locationName:locations.get(item.locationId).name,importDetails:{
    name:item.name??original.name,number:original.cardNo,rarity:original.rarity,illustration:original.illustration,
   }});
  }
  state.locations=[...locations.values()].sort((a,b)=>a.position-b.position);
  state.profile.revision=change.revision;
  snapshotRevision=change.revision;
  return true;
 }
 async function inventorySnapshot(){
  const token=state.token;
  while(token && token===state.token && refreshedInventory!==inventoryRefresh){
   const version=inventoryRefresh;
   const value=await api('bootstrap');
   if(token!==state.token)break;
   if(version!==inventoryRefresh || older(value.profile.revision,state.profile.revision))continue;
   receive(value);
   refreshedInventory=version;
  }
  return snapshot();
 }
 function metadata(card){
  const attributes=['DARK','LIGHT','EARTH','WATER','FIRE','WIND','DIVINE'];
  const races=['Dragon','Zombie','Fiend','Pyro','Sea Serpent','Rock','Machine','Fish','Dinosaur','Insect','Beast','Beast-Warrior','Plant','Aqua','Warrior','Winged Beast','Fairy','Spellcaster','Thunder','Reptile','Creator God','Divine-Beast','Psychic','Wyrm','Cyberse','Illusion'];
  const properties=['Normal','Effect','Ritual','Fusion','Synchro','Xyz','Pendulum','Spirit','Toon','Tuner','Union','Gemini','Flip','Link','Special Summon','Normal Spell','Continuous Spell','Quick-Play Spell','Field Spell','Equip Spell','Ritual Spell','Normal Trap','Continuous Trap','Counter Trap'];
  const info={10:card.type==='Spell'?1:card.type==='Trap'?2:0,11:(card.properties||[]).map(p=>properties.indexOf(p)).filter(i=>i>=0),12:card.lv,13:attributes.indexOf(card.attribute),14:races.indexOf(card.race),15:card.atk,16:card.def,17:card.pendulumScale};
  locales.forEach((locale,index)=>{const localized=card.localizations?.find(l=>l.locale===locale);if(!localized)return;const arts=(card.artworks||[]).filter(a=>a.locales.includes(locale));info[index]=[localized.name,arts.map(a=>slots(card).get(a.id)),[],localized.text||'',localized.pendulumText||''];});
  const cardLocales=locales.filter(locale=>card.localizations?.some(localized=>localized.locale===locale));
  const linkLocale=cardLocales.includes(UIStore.currentRegion)?UIStore.currentRegion:cardLocales[0]||UIStore.currentRegion||'ko';
  return {success:true,cid:card.cid,name:card.name,info,isFull:card.inventoryOnly!==true,cachedAt:Date.now(),linkData:{id:card.cid,locale:linkLocale,locales:cardLocales},sqlArtworks:card.artworks};
 }
 function searchResult(card,key,matchedNumber){
  if(!card)return {success:false,isError:true,name:'카드 확인하세요',message:'카탈로그에서 카드를 찾을 수 없습니다.'};
  const printings=card.printings.filter(p=>card.variants.some(v=>v.printingId===p.id)&&(matchedNumber ? p.number?.toUpperCase()===matchedNumber.toUpperCase() : !key?p.locale===UIStore.currentRegion:matchesNumber(p,key))),variants=card.variants.filter(v=>printings.some(p=>p.id===v.printingId));
  const number=p=>matchedNumber || (key && packNumberKey(p)===String(key).toUpperCase()) ? packNumberKey(p) : numberKey(p);
  return {...metadata(card),numbers:printings.map(number),illustrations:[...new Set(variants.map(v=>artSlot(card,v)))],rarities:['레어도',...new Set(variants.map(v=>v.rarityId))],raritiesByNo:Object.fromEntries(printings.map(p=>[number(p),['레어도',...new Set(variants.filter(v=>v.printingId===p.id).map(v=>v.rarityId))]]))};
 }
 function registrationOptions(cid,number){
  const card=cardFor(cid);
  if(!card || card.projectionOnly || card.inventoryOnly)return;
  number=String(number||'').trim();
  const printingIds=new Set(card.printings.filter(p=>number && matchesNumber(p,number)).map(p=>p.id));
  const variants=card.variants.filter(v=>printingIds.has(v.printingId));
  return {illustrations:[...new Set(variants.map(v=>artSlot(card,v)))],
   rarities:['레어도',...new Set(variants.map(v=>v.rarityId))]};
 }
 function index(){
  store.changed();
  numberCounts.clear();
  for (const card of state.cards) {
   for (const {number,count} of card.projectionOnly?card.numberUsage:card.printings) {
    if (number) numberCounts.set(number, (numberCounts.get(number) || 0) + (card.projectionOnly?Number(count):1));
   }
  }
  measureLoginStage('catalog_names',()=>{
  CardDataStore.allCardNames=[...new Set([...state.summaries.values(),...state.cards].flatMap(c=>(c.localizations||[]).map(l=>l.name)))];CardDataStore.allCardNumbers=[...new Set([...state.summaries.values()].flatMap(c=>c.matchedNumbers||[]).concat(state.cards.flatMap(c=>c.printings.map(numberKey))))];updateNormalizedNames();
  cardCacheInstance.setAllKnownNumbers?.(CardDataStore.allCardNumbers);
  },'getUserData');
  measureLoginStage('catalog_packs',()=>{
  CardDataStore.masterJSON.pack=Object.fromEntries(state.cards.flatMap(c=>c.printings.map(p=>[`${p.pid}_${p.locale}`,{name:p.packName,totalCards:p.reportedCardCount||1}])));
  },'getUserData');
  measureLoginStage('catalog_rarities',()=>{
  CardDataStore.masterJSON.rarity=[['display',...locales],...[...state.cards.reduce((map,c)=>{for(const r of c.rarities||[])if(!map.has(r.id))map.set(r.id,r);return map;},new Map()).values()].map(r=>[r.id,...locales.map(locale=>r.labels[locale]||r.labels.en||r.labels.ja||Object.values(r.labels)[0]||r.displayCode||'미확인')])];
  },'getUserData');
  measureLoginStage('catalog_metadata',()=>{
  updatePackNamesCache();
  ClientCache.rebuildMasterIndexes();
  isAppConfigured=true;
  for(const card of state.cards){ClientCache.registerCid(card.cid,[card.name,...(card.localizations||[]).map(l=>l.name)],card.printings.map(numberKey));cidMetaMemoryCache.set(card.cid,metadata(card));}
  },'getUserData');
 }
 const cardRequests=new Map();
 async function ensureCard(cid){
  const cached=cardFor(cid);if(cached&&!cached.inventoryOnly)return cached;
  if(!cardRequests.has(String(cid)))cardRequests.set(String(cid),api('cards/'+encodeURIComponent(cid)+'?locale='+(UIStore.currentRegion||'ko')).then(value=>{
   const cached=cardFor(cid);
   if(cached&&!cached.inventoryOnly)return cached;
   putCard(value.card);index();return value.card;
  }).finally(()=>cardRequests.delete(String(cid))));
  return cardRequests.get(String(cid));
 }
 function decodeCatalogRows(value){
  const invalid=()=>{throw Error('카드 정보를 확인하지 못했습니다.');};
  if(value?.format!=='schema-rows-v1'||!Array.isArray(value.schemas)||value.schemas.length>256)invalid();
  for(const keys of value.schemas)if(!Array.isArray(keys)||keys.length>64||new Set(keys).size!==keys.length||keys.some(key=>typeof key!=='string'||key.length>128))invalid();
  let nodes=0;
  const visit=(row,depth=0)=>{
   if(++nodes>2000000||depth>32)invalid();
   if(!Array.isArray(row)){if(row!==null&&typeof row==='object')invalid();return row;}
   const tag=row[0];
   if(tag===-1){const result=new Array(row.length-1);for(let i=1;i<row.length;i++)result[i-1]=visit(row[i],depth+1);return result;}
   if(!Number.isInteger(tag)||tag<0||tag>=value.schemas.length||row.length-1!==value.schemas[tag].length)invalid();
   const result={};for(let i=0;i<value.schemas[tag].length;i++){
    const key=value.schemas[tag][i],entry=visit(row[i+1],depth+1);
    if(key==='__proto__')Object.defineProperty(result,key,{value:entry,enumerable:true,writable:true,configurable:true});
    else result[key]=entry;
   }
   return result;
  };
  return visit(value.data);
 }
 async function loadInventoryCards(items,current,signal,inventoryOnly=false,combined=false,sharedRarities=false,catalogSeed){
  const allIds=[...new Set(items.map(item=>item.cid).filter(Boolean).map(String))];
  const controller=new AbortController();
  const cancel=()=>controller.abort(signal.reason);
  let next=0,failure;
  const requireCurrent=()=>{
   if(!current())throw Error('서비스 계정이 변경되었습니다.');
   controller.signal.throwIfAborted();
  };
  const validCards=(cards,cids)=>Array.isArray(cards) && cards.length===cids.length
   && new Set(cards.map(card=>card?.cid)).size===cids.length
   && cards.every(card=>card && (!inventoryOnly || card.inventoryOnly===true) && cids.includes(card.cid)
    && ['printings','variants','artworks','localizations','rarities'].every(key=>Array.isArray(card[key])));
  const decode=(value,groups,useCombined,useShared)=>{
    let received=useCombined?value.groups:[{index:groups[0].index,cards:value.cards}];
    if(useCombined && useShared){
     if(value.wireVersion!==1 || !Array.isArray(received))throw Error('카드 정보를 확인하지 못했습니다.');
     received=received.map(group=>{
      if(!group || !Array.isArray(group.rarities) || !Array.isArray(group.cards)
       || group.cards.some(card=>!card || Object.hasOwn(card,'rarities')))throw Error('카드 정보를 확인하지 못했습니다.');
      return {index:group.index,cards:group.cards.map(card=>{
       const {printings,variants,artworks,...fields}=card;
       return {...fields,rarities:group.rarities,printings,variants,artworks};
      })};
     });
    }
    if((useCombined && value.success!==true) || !Array.isArray(received) || received.length!==groups.length
      || received.some((group,index)=>group?.index!==groups[index].index || !validCards(group.cards,groups[index].cids)))throw Error('카드 정보를 확인하지 못했습니다.');
    return received;
  };
  let seedCards=[];
  if(catalogSeed!==undefined){
   requireCurrent();
   if(catalogSeed?.version!==1)throw Error('카드 정보를 확인하지 못했습니다.');
   if(Object.hasOwn(catalogSeed,'rows')){
    if(Object.hasOwn(catalogSeed,'groups'))throw Error('카드 정보를 확인하지 못했습니다.');
    catalogSeed={...catalogSeed,groups:decodeCatalogRows(catalogSeed.rows)};
   }
   const firstIds=allIds.slice(0,100),groups=[];
   for(let offset=0;offset<firstIds.length;offset+=25)groups.push({index:groups.length,cids:firstIds.slice(offset,offset+25)});
   const decoded=decode({success:true,...catalogSeed},groups,true,true);
   // 이미 준비된 공개 카드 캐시는 기존 조회/레어도 범위를 그대로 유지한다.
   if(state.cards.length===0 && catalogSeed.locale===(UIStore.currentRegion||'ko'))seedCards=decoded.flatMap(group=>group.cards);
  }
  const seeded=new Set(seedCards.map(card=>card.cid));
  const ids=allIds.filter(cid=>!cardFor(cid)&&!seeded.has(cid));
  const count=Math.ceil(ids.length/25),width=combined?4:1,requestCount=Math.ceil(count/width);
  const results=new Array(count);
  const worker=async()=>{
   while(!failure && next<requestCount){
    requireCurrent();
    const first=next++*width,groups=[];
    for(let index=first;index<Math.min(first+width,count);index++){
     const cids=ids.slice(index*25,index*25+25).filter(cid=>!cardFor(cid));
     if(cids.length)groups.push({index,cids});
    }
    if(!groups.length)continue;
    const appCheck=state.firebaseUser ? await getRegistrationAppCheck(controller.signal) : undefined;
    requireCurrent();
    const locale=UIStore.currentRegion||'ko';
    const value=combined
     ? await api('catalog/inventory-batches',{locale,groups,...(sharedRarities?{wireFormat:'shared-rarities-v1'}:{})},{includeToken:false,appCheck,signal:controller.signal})
     : await api('catalog/registration',{locale,cids:groups[0].cids,includeDetails:true,...(inventoryOnly?{inventoryOnly:true}:{})},{includeToken:false,appCheck,signal:controller.signal});
    requireCurrent();
    const received=decode(value,groups,combined,sharedRarities);
    // 응답 전체를 확인한 뒤 기존 25종 묶음 위치에 보관한다. 실패 시에는 아무 캐시도 반영하지 않는다.
    for(const group of received)results[group.index]=group.cards;
   }
  };
  if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
  try{
   await Promise.all(Array.from({length:Math.min(2,requestCount)},()=>worker().catch(error=>{
    failure ||= error;controller.abort();
   })));
   if(failure)throw failure;
   requireCurrent();
   const known=new Set(state.cards.map(card=>card.cid));
   for(const cards of [seedCards,...results])for(const card of cards||[])if(!known.has(card.cid)){putCard(card);known.add(card.cid);}
   if(seedCards.length||ids.length)measureLoginStage('catalog_index',index,'getUserData');
  }finally{signal?.removeEventListener('abort',cancel);}
 }
 async function search(query,{after='0',limit=50,autocomplete=false,field,view,signal,updateIndex=true,continuation=false}={}){
  const params=new URLSearchParams({q:query,locale:UIStore.currentRegion||'ko',after,limit});
  if(autocomplete)params.set('mode','autocomplete');
  if(field)params.set('field',field);
  if(view)params.set('view',view);
  if(continuation)params.set('continuation','1');
  const value=await api('search?'+params,undefined,{includeToken:!autocomplete,signal});
  if(updateIndex)rememberSearchResults(value);
  return value;
 }
 function rememberSearchResults(value){
  for(const card of value.cards){state.summaries.set(card.cid,card);if(!cardFor(card.cid)){
   const meta={...metadata(card),isFull:false};cidMetaMemoryCache.set(card.cid,meta);catalogCompleteMetadata.add(meta);
   ClientCache.registerCid(card.cid,(card.localizations||[]).map(l=>l.name),card.matchedNumbers||[]);
  }}index();
 }
 async function searchAutocomplete(query,options){
  const args={...options,autocomplete:true};
  const matching=root.YgoCardNameAutocomplete;
  const versions=options.field==='number'||!matching ? [] : matching.variants(matching.normalize(query));
  if(versions.length<=1)return search(query,args);
  if(state.nameAutocompleteContinuation)return search(query,{...args,continuation:true});

  // 구형 시험 API도 기존 인덱스에서 각 완성형을 조회한다.
  const replies=await Promise.all(versions.map((value,i)=>search(value,{
   ...args,field:i===0?args.field:'name',updateIndex:false
  })));
  const cards=new Map();
  for(const reply of replies)for(const card of reply.cards){
   const previous=cards.get(card.cid);
   const matchedNames=[...new Set([...(previous?.matchedNames||[]),...(card.matchedNames||[])])];
   const matchedNumbers=[...new Set([...(previous?.matchedNumbers||[]),...(card.matchedNumbers||[])])];
   cards.set(card.cid,{...card,matchedNames,matchedNumbers});
  }
  const prefix=new RegExp('^'+matching.pattern(versions[0],versions),'u');
  const rank=card=>{
   const values=[...card.matchedNames,...card.matchedNumbers].map(matching.normalize);
   if(values.includes(versions[0]))return 0;
   return values.some(value=>prefix.test(value)) ? 1 : 2;
  };
  const ordered=[...cards.values()].map(card=>({card,rank:rank(card)}))
   .sort((a,b)=>a.rank-b.rank||Number(a.card.cid)-Number(b.card.cid));
  const visible=ordered.slice(0,options.limit).map(({card})=>card);
  const result={cards:visible,next:ordered.length>visible.length||replies.some(reply=>reply.next) ? visible.at(-1)?.cid??null : null};
  if(options.updateIndex!==false)rememberSearchResults(result);
  return result;
 }
 async function registrationSuggestions(query,field,signal){
  const result=await searchAutocomplete(query,{limit:25,field:field==='name'?'name':'number',view:'suggestions',signal,updateIndex:false});
  if(field==='name')return result.cards.flatMap(card=>[...new Set(card.matchedNames)]
   .map(value=>({value,cid:card.cid})));
  const numbers=new Map();
  for(const card of result.cards)for(const value of new Set(card.matchedNumbers)){
   if(!numbers.has(value))numbers.set(value,{value,cards:[],complete:result.next===null});
   numbers.get(value).cards.push({value:card.name,cid:card.cid});
  }
  return [...numbers.values()];
 }
 async function registrationNumber(cid,number){
  const card=await ensureCard(cid);
  const printings=card.printings.filter(p=>p.number?.toUpperCase()===number.toUpperCase()
   && card.variants.some(v=>v.printingId===p.id));
  return {name:card.name,number:printings.length===1?(numberCounts.get(number)===1?printings[0].number:packNumberKey(printings[0])):null,multiple:printings.length>1};
 }
 async function find(query){const result=await search(query,{limit:100});await Promise.all(result.cards.map(c=>ensureCard(c.cid)));return result.cards.map(c=>cardFor(c.cid));}
 async function resolveDeckCardIds(names){
  const locale=UIStore.currentRegion||'ko';
  const keys=[...new Set(names.map(name=>name.normalize('NFC').trim()).filter(name=>name && name.length<=100))];
  const matches=new Map(), cards=new Map();
  for(let offset=0;offset<keys.length;offset+=25){
   const result=await api('catalog/registration',{locale,names:keys.slice(offset,offset+25)},{includeToken:false});
   for(const [name,cid] of result.matches)matches.set(name,cid);
   for(const card of result.cards)cards.set(card.cid,card);
  }
  if(cards.size){
   const cached=new Map(state.cards.map(card=>[card.cid,card]));
   for(const [cid,card] of cards)cached.set(cid,card);
   state.cards=[...cached.values()];
   index();
  }
  return matches;
 }
 async function lookupPhotoCardNames(cids){
  const locale=UIStore.currentRegion||'ko';
  const keys=[...new Set(cids.map(String).filter(cid=>/^[1-9]\d{0,9}$/.test(cid) && Number(cid)<=2147483647))];
  const names=new Map();
  const missing=keys.filter(cid=>{
   const cached=cardFor(cid);
   if(!cached)return true;
   names.set(cid,extractLangData(metadata(cached))?.[0]||cached.name);
   return false;
  });
  for(let offset=0;offset<missing.length;offset+=100){
   const result=await api('catalog/registration',{locale,cids:missing.slice(offset,offset+100)},{includeToken:false});
   for(const card of result.cards)names.set(card.cid,extractLangData(metadata(card))?.[0]||card.name);
  }
  return names;
 }
 async function ready(){return state.ready ||=Promise.resolve().then(index);}
 async function login(){
  await ready();let value;
  if(state.token){try{value=await api('bootstrap');}catch(error){if(error.status!==401)throw error;state.token=null;}}
  if(!state.token){value=await api('demo/session',{});state.token=value.token;sessionStorage.setItem(sessionKey,state.token);}
  return finishLogin(value,{uid:value.profile.userId,displayName:'체험 계정',providerData:[],getIdTokenResult:async()=>({claims:{}})});
 }
 async function loginFirebase(user,isCurrent=()=>true,initialData){
  const signal=AbortSignal.timeout(30000);
  const current=()=>isCurrent()&&!signal.aborted;
  await ready();
  requireRegistrationOwner(user);
  if(!current())throw Error('서비스 계정이 변경되었습니다.');
  // 구형 API가 초기 자료를 제공하지 않을 때만 기존 같은 출처 조회를 사용한다.
  const value=initialData===undefined ? await api('bootstrap',undefined,{signal}) : initialData;
  requireRegistrationOwner(user);
  if(!current() || value?.profile?.userId!==user.uid)throw Error('서비스 계정이 변경되었습니다.');
  if(!Array.isArray(value.items) || !Array.isArray(value.locations)
    || typeof value.profile.revision!=='string' || !/^\d+$/.test(value.profile.revision)
    || typeof value.generation!=='string' || !/^\d+$/.test(value.generation)
    || (initialData!==undefined && value.success!==true))throw Error('초기 보유 정보를 확인하지 못했습니다.');
  state.token=user.uid;
  return finishLogin(value,user,current,signal);
 }
 async function registration(user,body,{includeUserData=false}={}){
  const signal=AbortSignal.timeout(30000);
  const request=async forceRefresh=>{
   requireRegistrationOwner(user);
   const warmup=forceRefresh?null:loginAppCheckWarmup;
   let appCheck,preparedToken;
   try{[appCheck,preparedToken]=await Promise.all([
    measureLoginStage('app_check',()=>warmup?awaitApiPreparation(warmup,signal):getRegistrationAppCheck(signal,forceRefresh),'getRegistrationStatus'),
    measureLoginStage('id_token',()=>awaitApiPreparation(user.getIdToken(),signal),'getRegistrationStatus')]);}
   finally{if(warmup && loginAppCheckWarmup===warmup)loginAppCheckWarmup=null;}
   requireRegistrationOwner(user);
   const path=body===undefined && includeUserData ? 'registration?includeUserData=true'+(state.cards.length===0?'&includeInventoryCatalog=true&inventoryLocale='+encodeURIComponent(UIStore.currentRegion||'ko')+'&inventoryCatalogEncoding=rows-v1':'&inventoryLocale='+encodeURIComponent(UIStore.currentRegion||'ko'))+'&initialView=inventory-v1' : 'registration';
   const result=await api(path,body,{appCheck,signal,registrationOwner:user,preparedToken});
   requireRegistrationOwner(user);
   return result;
  };
  try{return await request(false);}
  catch(error){
   if(error.retryable===false || error.status!==401
     || !['APPCHECK_REQUIRED','APPCHECK_INVALID'].includes(error.code))throw error;
   return request(true);
  }
 }
 async function finishLogin(value,user,isCurrent=()=>true,signal){
  const token=state.token;
  const firebaseUser=state.firebaseUser;
  const current=()=>isCurrent() && token===state.token && firebaseUser===state.firebaseUser && !signal?.aborted;
  const cards=measureLoginStage('inventory_catalog',async()=>{
   if(Object.hasOwn(value,'version')){
    const candidate=root.YgoInventoryState.validate(value,user.uid),projected=root.YgoInventoryState.projectedCards(candidate);
    if(!current())throw Error('서비스 계정이 변경되었습니다.');
    const merged=new Map([...store.root.catalog.cards].filter(([,card])=>!card.projectionOnly));
    for(const card of projected)if(!merged.has(card.cid))merged.set(card.cid,card);
    state.cards=[...merged.values()];
    store.root.readView={version:1,rulesVersion:value.rulesVersion,locale:value.locale,inventoryState:value.inventoryState};
    if(projected.length)measureLoginStage('catalog_index',index,'getUserData');
   }else await loadInventoryCards(value.items,current,signal,value.inventoryCatalogVersion===1,value.inventoryCatalogVersion===1 && value.inventoryCatalogBatchVersion===1,value.inventoryCatalogWireVersion===1,value.inventoryCatalog);
  },'getUserData');
  await (signal ? awaitApiPreparation(cards,signal) : cards);
  if(!isCurrent() || token!==state.token || firebaseUser!==state.firebaseUser)throw Error('서비스 계정이 변경되었습니다.');
  if(firebaseUser)requireRegistrationOwner(firebaseUser);
  store.root.session.phase='presenting';
  measureLoginStage('inventory_receive',()=>receive(value),'getUserData');
  const endRender=root.YgoLoginTiming?.current()?.begin('render');
  UserStore.user=user;
  if(firebaseUser && typeof AutoLogoutManager!=='undefined' && AutoLogoutManager.start()===false)return;
  window.isAuthInitialized=true;UserStore.isInitialSyncDone=true;UserStore.isUserDataSyncDone=true;UserStore.inventorySyncStatus='ready';UserStore.settings.hideMembershipVerify=state.preferences.hideMembershipVerify!==false;
  applyAccount(value);
  syncAccountClaims(value,user);
  document.getElementById('home-unauth-content').hidden=true;document.getElementById('home-auth-content').hidden=false;
  const data=measureLoginStage('snapshot',snapshot,'getUserData');
  cardCacheInstance.bindInventorySource?.({snapshot});
  applyUserData(data);updateUserInfoCard(user,{Nickname:state.profile.nickname,createdAt:state.profile.createdAt});renderLinkedAccounts(user);showLoading(false);getAppModal(document.getElementById('auth-modal'))?.close();
  store.root.session.phase='ready';
  endRender?.(true);root.YgoLoginTiming?.current()?.checkpoint('inventory_ready');
  if(!firebaseUser)showToast('샘플 계정으로 연결했습니다.','');
  if(typeof OnboardingManager !== 'undefined')OnboardingManager.authChanged(true);return user;
 }
 async function command(input,pendingKey){
  const token=state.token, epoch=resetEpoch;
  let pending=state.pending.get(pendingKey);if(!pending){pending={...input,requestId:crypto.randomUUID()};state.pending.set(pendingKey,pending);}
  const forget=()=>{if(state.pending.get(pendingKey)===pending)state.pending.delete(pendingKey);};
  try{const value=await api('inventory/commands',pending);forget();if(token===state.token && epoch===resetEpoch)delta(value);return value;}catch(error){if(error.status&&error.status<500)forget();throw error;}
 }
 async function location(name){let found=state.locations.find(l=>l.name===name);if(!found){const token=state.token,epoch=resetEpoch;found=(await api('locations',{name})).location;if(token!==state.token||epoch!==resetEpoch)throw Object.assign(Error('INVENTORY_GENERATION_CHANGED'),{status:409});state.locations=[...state.locations,found];}return found;}
 async function deleteLocation(name, expectedVersion){
  const token=state.token, epoch=resetEpoch, sessionEpoch=store.root.session.epoch;
  const isCurrent=()=>token===state.token && epoch===resetEpoch && sessionEpoch===store.root.session.epoch;
  const target=state.locations.find(entry=>entry.name===name);
  if(!target)throw Object.assign(Error('보관 위치를 찾을 수 없습니다.'),{code:'LOCATION_NOT_FOUND'});
  const key=JSON.stringify(['deleteLocation',target.id]);
  let pending=state.pending.get(key);
  if(!pending){
   const {revision,generation}=expectedVersion;
   pending={requestId:crypto.randomUUID(),locationId:target.id,revision,generation};
   state.pending.set(key,pending);
  }
  const forget=()=>{if(state.pending.get(key)===pending)state.pending.delete(key);};
  try{
   const value=await api('locations/delete',pending);
   if(!value.success || value.locationId!==target.id || typeof value.revision!=='string' || !/^\d+$/.test(value.revision)
      || BigInt(value.revision)!==BigInt(pending.revision)+1n)throw Error('위치 삭제 결과를 확인하지 못했습니다.');
   if(isCurrent() && older(state.profile.revision,value.revision)){
    if(state.profile.revision===pending.revision && state.generation===pending.generation){
     state.locations=state.locations.filter(entry=>entry.id!==target.id);
     for(const item of state.items.values())if(item.locationId===target.id)state.items.delete(item.id);
     state.profile.revision=value.revision;
     snapshotRevision=value.revision;
    }else{
     inventoryRefresh++;
     await inventorySnapshot();
    }
   }
   forget();
   return snapshot();
  }catch(error){
   if(error.status && error.status<500)forget();
   if(isCurrent() && ['INVENTORY_REVISION_CHANGED','INVENTORY_GENERATION_CHANGED','LOCATION_NOT_FOUND'].includes(error.code)){
    inventoryRefresh++;
    try{error.inventory=await inventorySnapshot();}catch(_){}
   }
   throw error;
  }
 }
 async function addCards(rows){
  for(const cid of new Set(rows.map(row=>String(row[6]||'')).filter(Boolean)))if(cardFor(cid)?.projectionOnly)await ensureCard(cid);
  const token=state.token, uid=state.profile?.userId;
  if(!token||!uid)throw Error('로그인 정보를 확인해 주세요.');
  const pendingKey=JSON.stringify(['addCards',rows]);
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([uid,pendingKey])));
  const storageKey='synapse-sql-add-request:'+Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  if(token!==state.token)throw Error('서비스 계정이 변경되었습니다.');
  let payload=state.pending.get(pendingKey);
  if(!payload){
   if(!state.generation || refreshedInventory!==inventoryRefresh) {
    if(refreshedInventory===inventoryRefresh)inventoryRefresh++;
    await inventorySnapshot();
   }
   if(token!==state.token || typeof state.generation!=='string')throw Error('보유 정보 동기화가 필요합니다.');
   let attempt;
   try {
    const saved=sessionStorage.getItem(storageKey);
    attempt=saved?JSON.parse(saved):{requestId:crypto.randomUUID(),generation:state.generation};
    if(typeof attempt?.requestId!=='string' || typeof attempt.generation!=='string')throw Error();
    if(!saved)sessionStorage.setItem(storageKey,JSON.stringify(attempt));
   }catch(_){throw Error('등록 요청을 보관할 수 없습니다. 브라우저 저장 설정을 확인해 주세요.');}
   payload={...attempt,rows:rows.map(([name,number,rarity,quantity,location,illustration,cid])=>{
    const card=cardFor(cid)||state.cards.find(candidate=>candidate.name===name&&printingFor(candidate,number));
    const printing=printingFor(card,number);
    const variants=card?.variants.filter(v=>v.printingId===printing?.id&&v.rarityId===String(rarity)&&artSlot(card,v)===String(illustration))||[];
    return {variantId:variants.length===1?variants[0].id:null,location,quantity:Number(quantity)};
   })};
   state.pending.set(pendingKey,payload);
  }
  const forget=()=>{
   if(state.pending.get(pendingKey)!==payload)return;
   state.pending.delete(pendingKey);
   try {
    if(JSON.parse(sessionStorage.getItem(storageKey))?.requestId===payload.requestId)sessionStorage.removeItem(storageKey);
   }catch(_){}
  };
  let confirmed=false;
  try{
   const value=await api('inventory/add-batch',payload);
   confirmed=true;
   if(token!==state.token)throw Error('서비스 계정이 변경되었습니다.');
   if(value.replayed || state.profile.revision!==value.fromRevision || refreshedInventory!==inventoryRefresh)inventoryRefresh++;
   else {
    const locations=new Map(state.locations.map(l=>[l.id,l]));
    for(const l of value.locations)locations.set(l.id,l);
    state.locations=[...locations.values()].sort((a,b)=>a.position-b.position);
    delta(value);
   }
   const snapshot=await inventorySnapshot();
   forget();
   return {...snapshot,updatedItems:[],operationResults:value.operationResults};
  }catch(error){
   if(!confirmed && error.status && error.status<500)forget();
   if(token===state.token && error.code==='INVENTORY_GENERATION_CHANGED')inventoryRefresh++;
   throw error;
  }
 }
 async function management(action,data){
  const submitted=action==='moveCards'?data.moves:data.discards;const operationResults=[];
  for(const [requestIndex,entry]of submitted.entries()){
   const r=Array.isArray(entry)?{name:entry[0],cardNo:entry[1],rarity:entry[2],qty:Number(entry[3]),loc:entry[4],illustration:entry[5],cid:entry[6]}:entry;
   const qty=Number(r.moveQty??r.qty);const pendingKey=JSON.stringify([action,r]);
   try{
    const source=state.locations.find(l=>l.name===(r.currentLoc||r.loc));
    const requestedId=r.itemId??(Array.isArray(entry)?entry[7]:undefined);
    const matches=item=>{
     if(item.locationId!==source?.id)return false;
     if(r.cid && String(item.cid)!==String(r.cid))return false;
     const fields=row(item),name=r.name||r.cardName;
     const sameName=!name || fields[0]===name || (!item.importDetails && cardFor(item.cid)?.localizations?.some(entry=>entry.name===name));
     return sameName && fields[1].toUpperCase()===String(r.cardNo).toUpperCase()
      && String(fields[2])===String(r.rarity) && fields[5]===String(r.illustration);
    };
    let item;
    if(requestedId){
     item=state.items.get(requestedId);
     if(!item||!matches(item))throw Error('INVENTORY_ITEM_CHANGED');
    }else{
     const candidates=[...state.items.values()].filter(matches);
     if(candidates.length>1)throw Error('AMBIGUOUS_INVENTORY_ITEM');
     item=candidates[0];
    }
    if(!item)throw Error('INSUFFICIENT_QUANTITY');
    await command({action:action==='moveCards'?'move':'discard',itemId:item.id,quantity:qty,...(action==='moveCards'?{locationId:(await location(r.targetLoc)).id}:{})},pendingKey);
    operationResults.push({requestIndex,status:'success',qty});
   }catch(error){operationResults.push({requestIndex,status:'fail',failReason:error.message==='INSUFFICIENT_QUANTITY'?'insufficient_qty':['AMBIGUOUS_INVENTORY_ITEM','INVENTORY_ITEM_CHANGED'].includes(error.message)?'invalid_no':!error.status||error.status>=500?'unconfirmed_result':'server_error',qty:0});}
  }
  return {...snapshot(),updatedItems:[],operationResults};
 }
 async function settingsApi(path,body){
  if(state.auth!=='firebase')return api(path,body);
  const user=state.firebaseUser;
  requireRegistrationOwner(user);
  const signal=AbortSignal.timeout(30000);
  const appCheck=await getRegistrationAppCheck(signal);
  return api(path,body,{appCheck,signal,registrationOwner:user});
 }
 async function clearInventory(){
  const token=state.token, uid=state.profile?.userId;
  if(!token || !uid)throw Object.assign(Error('로그인 정보를 확인해 주세요.'),{status:401});
  const key='synapse-sql-clear-request:'+uid;
  let requestId;
  try{
   requestId=sessionStorage.getItem(key);
   if(!requestId){requestId=crypto.randomUUID();sessionStorage.setItem(key,requestId);}
  }catch(_){throw Error('초기화 요청을 보관할 수 없습니다. 브라우저 저장 설정을 확인해 주세요.');}
  const value=await settingsApi('clearUserData',{requestId});
  if(value.success){
   try{if(sessionStorage.getItem(key)===requestId)sessionStorage.removeItem(key);}catch(_){}
   if(token===state.token){
    if(older(state.profile.revision,value.revision)){
     resetEpoch++;
     state.pending.clear();
     state.items.clear();state.locations=[];state.profile.revision=value.revision;snapshotRevision=value.revision;
    }
    inventoryRefresh++;
   }
  }
  return value;
 }
 const membershipActions={
  startDiscordMembershipVerification:'discord/start',verifyDiscordMembership:'discord/verify',
  startYoutubeMembershipVerification:'youtube/start',verifyYoutubeMembership:'youtube/verify',
 };
 async function requestMembership(endpoint,data,owner,revision=authStateRevision){
  const requireCurrentOwner=()=>{
   if(revision!==authStateRevision)throw Error('서비스 계정이 변경되었습니다.');
   requireRegistrationOwner(owner);
  };
  requireCurrentOwner();
  const signal=AbortSignal.timeout(45000);
  const [appCheck,preparedToken]=await Promise.all([
   getRegistrationAppCheck(signal),
   awaitApiPreparation(owner.getIdToken(),signal),
  ]);
  requireCurrentOwner();
  const resultStream=endpoint.endsWith('/verify') ? root.YgoAuthenticationResult : undefined;
  const value=await api('membership/'+endpoint,data||{},{appCheck,signal,registrationOwner:owner,preparedToken,resultStream});
  requireCurrentOwner();
  if(value.uid!==owner.uid)throw Error('서비스 계정이 변경되었습니다.');
  return value;
 }
 function applyMembershipResult(value){
  if(value.membership){
   membershipRequest=null;
   applyAccount(value);
  }
 }
 async function dispatch(action,params={},data){
  if(['getRegistrationStatus','completeRegistration'].includes(action) && state.firebaseUser){
   const user=state.firebaseUser;
   if(action==='completeRegistration'){
    if(pendingRegistrationUser!==user)throw Error('서비스 계정이 변경되었습니다.');
    return registration(user,data);
   }
   return registration(user);
  }
  await ready();
  if(Object.hasOwn(membershipActions,action)){
   const endpoint=membershipActions[action], [provider]=endpoint.split('/');
   if(!state.firebaseUser || !state.membershipProviders?.includes(provider))return unavailable();
   const value=await requestMembership(endpoint,data,state.firebaseUser);
   applyMembershipResult(value);
   return value;
  }
  if(action==='getNotices')return api('notices');
  if(action==='getUserData'){
   if(data?.membershipClaimsOnly)return prepareMembershipEntry({claimsOnly:true});
   await prepareMembershipEntry();
   return inventorySnapshot();
  }
  if(action==='clearUserData')return clearInventory();
  if(action==='deleteLocation')return deleteLocation(data.name,data.version);
  if(action==='checkSheet'){
   const query=new URLSearchParams(params).toString();
   return settingsApi(action+(query?'?'+query:''),data??undefined);
  }
  if(['migrateFromData','migrateFromSheet'].includes(action)){
   const token=state.token, search=new URLSearchParams(params);
   if(data!=null)search.set('inventoryView','delta');
   const query=search.toString();
   const value=await api(action+(query?'?'+query:''),data??undefined);
   if(token===state.token && value.success && (data!=null || value.importRequest?.status==='completed') && !applyImportDelta(value))inventoryRefresh++;
   return value;
  }
  if(action==='getRamMemoryStats')return {success:true};
  if(action==='searchCardByName'){
   if(params.cid)return searchResult(await ensureCard(params.cid),undefined,params.matchedNumber);
   await find(params.name||'');return searchResult(state.cards.find(c=>c.name===params.name||c.localizations?.some(l=>l.name===params.name)));
  }
  if(action==='searchCardByNo'){
   let card=state.cards.find(c=>printingFor(c,params.cardNo));
   if(!card||card.projectionOnly){await find(params.cardNo||'');card=state.cards.find(c=>!c.projectionOnly&&printingFor(c,params.cardNo));}
   return searchResult(card,params.cardNo);
  }
  if(action==='getCardMetadata'){const c=params.cid?await ensureCard(params.cid):(await find(params.name||params.cardNo||''))[0];return c?metadata(c):{success:false};}
  if(action==='getCardsMetaBatch'){const cards=await Promise.all((data?.cids||[]).map(ensureCard));return {success:true,results:Object.fromEntries(cards.map(c=>[c.cid,metadata(c).info]))};}
  if(action==='resolveCardNames')return {success:true,results:Object.fromEntries((data?.names||[]).map(name=>[name,state.cards.filter(c=>c.name===name).map(c=>c.cid)])),numberResults:Object.fromEntries((data?.numbers||[]).map(number=>[number,state.cards.filter(c=>c.printings.some(p=>numberKey(p)===number)).map(c=>({cid:c.cid,name:c.name}))])),metadata:Object.fromEntries(state.cards.map(c=>[c.cid,metadata(c).info]))};
  if(action==='addCards')return addCards(data.rows);
  if(['moveCards','discardCards'].includes(action))return management(action,data);
  if(action==='updateUserSettings'){const token=state.token;const value=await api('preferences',data?.settings||{});if(token===state.token)state.preferences={...state.preferences,...value.preferences};return {success:true};}
  if(action==='updateNickname'){state.profile={...state.profile,...(await api('profile',{nickname:data?.nickname||params.nickname})).profile};return {success:true,nickname:state.profile.nickname};}
  if(action==='searchPack'){
   const {packs}=await api('packs?'+new URLSearchParams({name:params.packName||''}),undefined,{includeToken:false});
   const filtered=params.locale?packs.filter(pack=>pack.locale===params.locale):packs;
   const found=filtered.length?filtered:packs;
   if(!found.length)return {isError:true,message:'수록 목록이 확정된 팩을 찾을 수 없습니다.'};
   if(found.length===1){
    const p=found[0];return {success:true,packId:p.pid,packName:p.name,totalCards:p.totalCards,validLocale:p.locale,message:`수록된 카드 ${p.totalCards}장 발견`};
   }
   return {success:true,isMultiple:true,packName:params.packName,totalCards:Math.max(...found.map(p=>p.totalCards)),
    foundLocales:found.map(p=>({locale:p.locale,targetUrl:p.pid,totalCards:p.totalCards})),message:'발매 국가 선택'};
  }
  if(action==='getPackCids'||action==='crawlPackCardsBatch'){
   const offset=Number(params.offset||0);
   const detail=action==='crawlPackCardsBatch';
   const locale=params.locale||'ko';
   if(!detail)return api('packs/'+encodeURIComponent(params.packId)+'/cids?'+new URLSearchParams({locale,offset}),undefined,{includeToken:false});
   const value=data?.packPage || await fetchPackPage(params.packId,locale,offset,data?.signal);
   data?.signal?.throwIfAborted();
   for(const card of value.cards){
    putCard(card);
   }
   index();
   return {success:true,cards:value.cards.map((card,i)=>{
    const selected=card.packPrintings[0];
    const printing=card.printings.find(p=>p.id===selected.id);
    return {index:offset+i,cid:card.cid,name:card.name,
     cardNo:selected.uniqueNumber?printing.number:packNumberKey(printing),info:metadata(card).info};
   }),nextOffset:offset+value.cards.length,isDone:offset+value.cards.length>=value.total};
  }
  if(action==='searchDeck'||action==='getDeckCards'){
   const appCheck=typeof firebase==='undefined'?undefined:await getApiAppCheckToken();
   return api(action+'?'+new URLSearchParams(params),undefined,{appCheck});
  }
  if(action==='searchCardByImage'){
   const signal=AbortSignal.timeout(45000);
   const appCheck=await getRegistrationAppCheck(signal);
   return api(action,data,{includeToken:false,appCheck,signal});
  }
  return unavailable();
 }
 return {state,store,ready,login,loginFirebase,registration,dispatch,snapshot,metadata,artSlot,printingFor,registrationOptions,registrationSuggestions,registrationNumber,search,searchAutocomplete,ensureCard,resolveDeckCardIds,lookupPhotoCardNames,prepareMembershipEntry,requestMembership,applyMembershipResult,packSuggestions,fetchPackPage,
  isQualifiedNumber:value=>state.cards.some(card=>card.printings.some(printing=>packNumberKey(printing)===value))};
})();
let registrationAppCheck;
let loginAppCheckWarmup;
const loadedFirebaseScripts=new Map();
const preloadedFirebaseScripts=new Set();
const firebaseScripts=Object.freeze({app:'/__/firebase/13.0.0/firebase-app-compat.js',
 auth:'/__/firebase/13.0.0/firebase-auth-compat.js',appCheck:'/__/firebase/13.0.0/firebase-app-check-compat.js',config:'/__/firebase/init.js'});
const googleApiLoaderUrl='https://apis.google.com/js/api.js';
function prepareFirebaseSdkDownloads(){
 if(!productionHost || root.YgoDiscordPopup?.isCallback)return;
 const sdk=root.firebase,paths=[
  !sdk && firebaseScripts.app,
  !sdk?.auth && firebaseScripts.auth,
  !sdk?.appCheck && firebaseScripts.appCheck,
  !sdk?.apps?.length && firebaseScripts.config,
 ];
 for(const path of paths)if(path&&!preloadedFirebaseScripts.has(path)){
  const link=document.createElement('link');link.rel='preload';link.as='script';link.href=path;
  preloadedFirebaseScripts.add(path);document.head.append(link);
 }
}
function loadFirebaseScript(path){
 if(!loadedFirebaseScripts.has(path)){
  const loading=new Promise((resolve,reject)=>{
   const script=document.createElement('script');
   const failed=()=>{clearTimeout(timer);script.remove();reject(Error('앱 인증 도구를 불러오지 못했습니다.'));};
   const timer=setTimeout(failed,30000);
   script.src=path;
   script.onload=()=>{clearTimeout(timer);resolve();};
   script.onerror=failed;
   document.head.append(script);
  }).catch(error=>{loadedFirebaseScripts.delete(path);throw error;});
  loadedFirebaseScripts.set(path,loading);
 }
 return loadedFirebaseScripts.get(path);
}
function prepareRegistrationAppCheck(){
 registrationAppCheck ||= (async()=>{
  if(!root.firebase)await loadFirebaseScript(firebaseScripts.app);
  if(!root.firebase.appCheck)await loadFirebaseScript(firebaseScripts.appCheck);
  if(!root.firebase.apps.length)await loadFirebaseScript(firebaseScripts.config);
  const check=root.firebase.appCheck();
  if(!root.YgoAuthBootstrap?.appCheckStarted){
   if(typeof IS_LOCAL_DEV!=='undefined' && IS_LOCAL_DEV && root.FIREBASE_APPCHECK_DEBUG_TOKEN===undefined)root.FIREBASE_APPCHECK_DEBUG_TOKEN=true;
   // 모듈·프레임만 먼저 준비한다. 새 증명은 기존 로그인 요청에서 발급한다.
   check.activate(new root.firebase.appCheck.ReCaptchaEnterpriseProvider('6Le3FaksAAAAAFE9lMsuyGfgTkvNaVzrThMUthe3'),false);
  }
  return check;
 })().catch(error=>{registrationAppCheck=undefined;throw error;});
 return registrationAppCheck;
}
let lastLoginConnectionIntent=-Infinity;
function prepareLoginConnection(refresh=false){
 if(!client.state.directLoginRead)return;
 const previous=document.getElementById('login-api-preconnect'),now=performance.now();
 // 초기 힌트와 별개로 로그인 의도 때 갱신한다. 모달 열기·즉시 클릭의 중복만 묶는다.
 if(previous && (!refresh || now-lastLoginConnectionIntent<1000))return;
 try{
  const connection=document.createElement('link');connection.id='login-api-preconnect';connection.rel='preconnect';
  connection.href=directLoginOrigin;connection.crossOrigin='anonymous';
  if(previous)previous.replaceWith(connection);else document.head.appendChild(connection);
  if(refresh)lastLoginConnectionIntent=now;
 }catch(_){} // 선택적 연결 힌트가 로그인 진행을 막지 않는다.
}
let loginServerPreparation;
function prepareLoginServer(){
 if(!client.state.directLoginRead || loginServerPreparation)return;
 try{
  // 공개 환경 확인으로 기동만 유도한다. 개인 데이터·권한 확인은 기존 보호 조회에서 수행한다.
  const pending=fetch(directLoginOrigin+'/api/v2/environment',{
   method:'GET',mode:'cors',credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',
   signal:AbortSignal.timeout(5000),
  }).then(response=>response.arrayBuffer()).catch(()=>{});
  loginServerPreparation=pending;
  pending.finally(()=>{if(loginServerPreparation===pending)loginServerPreparation=null;});
 }catch(_){} // 준비 실패·시간 초과를 OAuth 실패로 전파하지 않는다.
}
function prepareSignIn(){
 // 환경 확인에 성공한 로그인 화면에서만 준비하며, 실패 안내에는 재발급을 걸지 않는다.
 if(!authEnvironment || loginInProgress || registrationCheckPending || pendingServiceAuthUser || serviceLoginFailureCode)return;
 return authEnvironment.then(auth=>{
  if(auth && !auth.currentUser && client.state.auth==='firebase'){
   prepareLoginConnection(true);
   if(productionHost && !loginInProgress && typeof root.gapi?.load!=='function'){
    // 팝업은 사용자의 클릭에서 기존 Firebase 로딩 경로로 시작할 수 있다.
    void loadFirebaseScript(googleApiLoaderUrl).catch(()=>{});
   }
   return prepareRegistrationAppCheck();
  }
 }).catch(()=>{});
}
function getRegistrationAppCheck(signal,forceRefresh=false){
 return awaitApiPreparation(prepareRegistrationAppCheck().then(async check=>{
  const token=await getApiAppCheckToken(forceRefresh);
  check.setTokenAutoRefreshEnabled?.(true);
  return token;
 }),signal);
}

function applyPhotoIllustration(input,item){
 const card=client.state.cards.find(candidate=>candidate.cid===String(item.cid));
 if(!card)return;
 const container=getActiveContainer(input);
 const rowData=JSON.parse(container?.dataset.cardData||'{}');
 if(String(rowData.linkData?.id)!==String(item.cid))return;
 const art=card.artworks.filter(candidate=>candidate.sources.some(source=>source.imageCiid===Number(item.ciid)&&source.imageVariant==='base'));
 if(art.length!==1)return;
 const value=client.artSlot(card,{artworkId:art[0].id});
 const options=JSON.parse(input.closest('.custom-select-wrapper')?.dataset.options||'[]');
 if(!options.some(option=>String(option.val)===value))return;
 setIllustrationValue(input,value);
 onSelectionChange(input);
}
async function loadCatalog(state,sequence){
 const current=()=>sequence===searchSequence&&lastSearchState===state&&UIStore.mode==='search';
 state.pending=true;state.error='';const items=new Map();let after='0';
 try{do{
  const result=await client.search(state.query,{after,limit:100});if(!current())return;
  for(const card of result.cards)items.set(card.cid,{cid:card.cid,name:card.name,nameMatch:card.matchedNames.length>0||String(card.cid)===state.query.trim(),numberMatch:card.matchedNumbers.length>0,number:card.matchedNumbers[0]||null});
  state.items=[...items.values()];renderCatalogResults(state);after=result.next;
 }while(after&&current());}
 catch(_){if(current())state.error='일부 카드 정보를 확인하지 못했습니다.';}
 finally{if(current()){state.pending=false;renderCatalogResults(state);}}
}
const suggestionSequences = { desktop: 0, mobile: 0 };
async function prepareSuggestions(value, mobile, signal) {
 const key = mobile ? 'mobile' : 'desktop', sequence = ++suggestionSequences[key];
 if (!value?.trim()) return true;
 try { await client.searchAutocomplete(value, { limit: 5, signal }); } catch (_) {}
 const input = document.getElementById(mobile ? 'mobile-card-search' : 'card-search');
 if (signal?.aborted || sequence !== suggestionSequences[key]
  || (input && ((mobile ? input.value.trim() : input.value) !== value || document.activeElement !== input))) return false;
 return true;
}
const sqlGalleryGroups=new WeakMap();
function sqlGalleryImages(card){
 if(!card)return [];if(sqlGalleryGroups.has(card))return sqlGalleryGroups.get(card);
 const groups=new Map();
 for(const source of card.artworks.flatMap(art=>art.sources)){
  if(!Number.isInteger(source.imageCiid)||source.imageCiid<1||!['base','jp'].includes(source.imageVariant))continue;
  const id=`image:${source.imageCiid}:${source.imageVariant}`;
  if(!groups.has(id))groups.set(id,{id,ciid:source.imageCiid,variant:source.imageVariant,sources:[]});
  const group=groups.get(id);if(!group.sources.some(s=>s.id===source.id))group.sources.push(source);
 }
 const result=[...groups.values()].sort((a,b)=>a.ciid-b.ciid||a.variant.localeCompare(b.variant));sqlGalleryGroups.set(card,result);return result;
}
const sqlArtworkPreloads=new Map();
function preloadArtwork(cid,id,options={}){
 const card=client.state.cards.find(c=>c.cid===String(cid));
 const group=options.gallery?sqlGalleryImages(card).find(g=>g.id===String(id)):null;
 const art=options.gallery?null:card?.artworks.find(a=>Number(client.artSlot(card,{artworkId:a.id}))===Number(id));
 const sources=options.gallery?group?.sources:art?.sources;
 const source=sources?.find(s=>s.locale===(UIStore.currentRegion||'ko'))||sources?.find(s=>s.imageCiid&&s.imageVariant);
 if(!source?.imageCiid||!source?.imageVariant)return Promise.resolve({status:'error',url:null});
 const url='/api/v2/artwork-sources/'+source.id+'.webp';
 const cacheKey=options.gallery?`${cid}:${group.id}`:url;
 if(!sqlArtworkPreloads.has(cacheKey))sqlArtworkPreloads.set(cacheKey,new Promise(resolve=>{
  const img=options.createImage?options.createImage():new Image();
  const finish=loaded=>{clearTimeout(timer);img.onload=img.onerror=null;if(!loaded)sqlArtworkPreloads.delete(cacheKey);resolve({status:loaded?'loaded':'error',url:loaded?url:null});};
  const timer=setTimeout(()=>finish(false),options.timeoutMs??10000);
  img.onload=()=>finish(true);img.onerror=()=>finish(false);img.src=url;
 }));
 return sqlArtworkPreloads.get(cacheKey);
};
function galleryLabel(cid,id){
 const group=sqlGalleryImages(client.state.cards.find(c=>c.cid===String(cid))).find(g=>g.id===String(id));
 return group?IllustrationImages.label(group.ciid)+(group.variant==='jp'?' (_jp)':''):'';
};
async function galleryEntries(cid){
 const card=client.state.cards.find(c=>c.cid===String(cid));
 const groups=sqlGalleryImages(card);
 const loaded=await Promise.all(groups.map(async group=>({group,image:await preloadArtwork(cid,group.id,{gallery:true})})));
 return loaded.filter(({image})=>image.status==='loaded'&&image.url).map(({group})=>[group.id,new Set(group.sources.filter(s=>s.released).map(s=>['한국','일본','아시아','중국','영어권','독일','프랑스','이탈리아','스페인','포르투갈'][['ko','ja','ae','cn','en','de','fr','it','es','pt'].indexOf(s.locale)]).filter(Boolean))]);
};


function onSelectionChange(input) {
 if(UIStore.mode!=='add'||input.dataset.field!=='illust')return;
 const container=getActiveContainer(input),data=JSON.parse(container?.dataset.cardData||'{}');
 const card=client.state.cards.find(c=>c.cid===String(data.linkData?.id));
 const number=(container?.querySelector('[data-field="no"]')?.value||'').trim();
 const p=client.printingFor(card,number);
 const art=card?.artworks.find(a=>Number(client.artSlot(card,{artworkId:a.id}))===Number(input.dataset.raw));
 const labels=[...new Set(card?.variants.filter(v=>v.printingId===p?.id&&v.artworkId===art?.id).map(v=>v.rarityId)||[])];
 const rare=container?.querySelector('[data-field="rare"]'),wrap=rare?.closest('.custom-select-wrapper');if(!wrap)return;
 wrap.dataset.options=JSON.stringify(labels.map(value=>({val:value,text:getLocalizedRarity(value)})));
 if(!labels.includes(rare.dataset.raw)){rare.value='';rare.dataset.raw='';}
 wrap.classList.toggle('no-option',labels.length===0);wrap.classList.toggle('single-option',labels.length===1);
 if(labels.length===1){rare.value=getLocalizedRarity(labels[0]);rare.dataset.raw=labels[0];}
 setupDropdownForField(rare,wrap);
}
let authEnvironment, firebaseLoginTask, preparedFirebaseAuth;
function discordReturnSession(user){
 if(!user || user!==client.state.firebaseUser || user!==root.firebase.auth().currentUser ||
    !client.state.membershipProviders?.includes('discord'))return null;
 const restore=firebaseLoginTask?.user===user ? firebaseLoginTask.promise : null;
 if(!restore && UserStore.user!==user)return null;
 const revision=authStateRevision;
 const isCurrent=()=>revision===authStateRevision && client.state.firebaseUser===user &&
  root.firebase.auth().currentUser===user && (!UserStore.user || UserStore.user===user);
 function requireRestoredOwner(){
  if(root.firebase.auth().currentUser!==user || (UserStore.user && UserStore.user!==user)){
   throw Object.assign(Error('서비스 계정이 변경되었습니다.'),{code:'DISCORD_SESSION_CHANGED'});
  }
  if(UserStore.user!==user || UserStore.inventorySyncStatus!=='ready'){
   throw Object.assign(Error('서비스 로그인을 복원하지 못했습니다.'),{code:'DISCORD_RESTORE_FAILED'});
  }
  if(revision!==authStateRevision || client.state.firebaseUser!==user){
   throw Object.assign(Error('서비스 계정이 변경되었습니다.'),{code:'DISCORD_SESSION_CHANGED'});
  }
 }
 return {
  user,
  isRestoring:()=>Boolean(restore && isCurrent() && UserStore.inventorySyncStatus!=='ready'),
  verify:proof=>client.requestMembership('discord/verify',proof,user,revision),
  async waitForInventory(){await restore;requireRestoredOwner();},
  apply(result){requireRestoredOwner();client.applyMembershipResult(result);},
 };
}
const productionHost = ['ygo-synapse.web.app','ygo-synapse.firebaseapp.com'].includes(root.location.hostname);
// 파일만 먼저 받는다. SDK 실행·앱 초기화·인증/App Check는 검증된 환경의 기존 경로에서 시작한다.
prepareFirebaseSdkDownloads();
function connectProductionServices() {
 for(const name of ['auth-preconnect','analytics','advertising']){
  const template=document.querySelector(`template[data-unconnected-service="${name}"]`);
  if(!template)continue;
  const content=template.content.cloneNode(true);
  for(const inactive of content.querySelectorAll('script')){
   const script=document.createElement('script');
   for(const {name,value} of inactive.attributes)script.setAttribute(name,value);
   script.textContent=inactive.textContent;
   inactive.replaceWith(script);
  }
  template.replaceWith(content);
 }
}
function openFirebaseSession(user){
 if(root.firebase.auth().currentUser!==user)return Promise.reject(Error('서비스 계정이 변경되었습니다.'));
 if(firebaseLoginTask?.user===user)return firebaseLoginTask.promise;
 if(client.state.firebaseUser===user && (UserStore.user===user || pendingRegistrationUser===user))return Promise.resolve();
 clearClientSession({preserveLogin:true});
 client.state.firebaseUser=user;
 client.store.root.session.phase='loading';
 registrationCheckPending=true;
 setServiceLoginPending(true);
 toggleLoginBtn();
 const task={user,revision:authStateRevision,timing:root.YgoLoginTiming?.start(),outcome:'superseded'};
 const current=()=>firebaseLoginTask===task && task.revision===authStateRevision && root.firebase.auth().currentUser===user;
 const read=()=>client.registration(user,undefined,{includeUserData:true});
 const statusTask=task.timing?task.timing.measure('registration_gate',read):read();
 const uiTask=task.timing?task.timing.measure('ui_ready_wait',()=>serviceUiReady):serviceUiReady;
 task.promise=Promise.all([uiTask,statusTask]).then(async([,status])=>{
  if(!current())return;
  if(!status?.success || typeof status.registered!=='boolean')throw Error('가입 상태 조회 실패');
  if(status.registered){if(Object.hasOwn(status,'initialView') && status.initialView?.version!==1)throw Error('초기 보유 정보를 확인하지 못했습니다.');await client.loginFirebase(user,current,Object.hasOwn(status,'initialView')?status.initialView:status.initialData);if(current())task.outcome='ready';return;}
  if(!status.consentVersions?.terms || !status.consentVersions?.privacy)throw Error('동의 문서 조회 실패');
  window.isAuthInitialized=true;
  getAppModal(document.getElementById('auth-modal'))?.close();
  client.store.root.session.phase='signup_required';
  openServiceRegistration(user,status.consentVersions);task.outcome='signup_required';
 }).catch(async error=>{
  if(!current())return;
  task.outcome='failed';
  clearClientSession();
  client.store.root.session.phase='error';
  if(['AUTH_INVALID','auth/user-disabled','auth/user-token-expired','auth/invalid-user-token'].includes(error.code)){
   const failureRevision=authStateRevision;
   await root.firebase.auth().signOut().catch(()=>{
    showToast('로그아웃하지 못했습니다. 다시 시도해 주세요.','toast-error');
   });
   const active=root.firebase.auth().currentUser;
   if(active && (active!==user || authStateRevision!==failureRevision))return;
   if(active)pendingServiceAuthUser=user;
   serviceLoginFailureCode='AUTH_INVALID';
  }else{
   pendingServiceAuthUser=user;
   serviceLoginFailureCode=error.reason==='throttled' ? 'APPCHECK_THROTTLED'
    : ['APPCHECK_CONFIGURATION_REJECTED','APPCHECK_UNAVAILABLE','SERVICE_CHECK_TIMEOUT'].includes(error.code) ? error.code
     : error.name==='AbortError' || error.name==='TimeoutError' ? 'SERVICE_CHECK_TIMEOUT' : 'SERVICE_CONNECTION_FAILED';
  }
  toggleAuthModal(true);
 }).finally(()=>{
  if(firebaseLoginTask===task){
   firebaseLoginTask=null;
   registrationCheckPending=false;
   setServiceLoginPending(false);
   toggleLoginBtn();
  }
  if(task.outcome==='ready')task.timing?.checkpoint('entry_ready');
  task.timing?.finish(task.outcome);
 });
 firebaseLoginTask=task;
 document.dispatchEvent?.(new Event('ygo:discord-session'));
 return task.promise;
}
async function loadFirebaseAuth(){
 if(!root.firebase)await loadFirebaseScript(firebaseScripts.app);
 await Promise.all([!root.firebase.auth && loadFirebaseScript(firebaseScripts.auth),
  !root.firebase.appCheck && loadFirebaseScript(firebaseScripts.appCheck)]);
 if(!root.firebase.apps.length)await loadFirebaseScript(firebaseScripts.config);
 if(productionHost)root.firebase.app().options.authDomain=root.location.hostname;
 return root.firebase.auth();
}
function hasDiscordReturn(){
 if(root.YgoDiscordPopup?.isCallback)return false;
 try{
  const pending=JSON.parse(sessionStorage.getItem('discord_membership_verification'));
  const params=new URLSearchParams(root.location.search);
  const code=params.get('code');
  return Boolean(pending && /^[a-f0-9]{64}$/.test(pending.state) && params.getAll('state').length===1 &&
   params.get('state')===pending.state && Number.isFinite(pending.expiresAt) && pending.expiresAt>Date.now() &&
   typeof pending.uid==='string' && pending.uid && params.getAll('code').length===1 && code && code.length<=2048 && !params.has('error'));
 }catch(_){return false;}
}
function observeFirebaseAuth(auth, environmentReady){
 return auth.onAuthStateChanged(async user=>{
  if(environmentReady && !await environmentReady)return;
  if(auth.currentUser!==user)return;
  if(!user){clearClientSession({preserveLogin:loginInProgress});return;}
  openFirebaseSession(user).catch(()=>{});
 });
}
function readAuthEnvironment(){
 return fetch('/api/v2/environment',{signal:AbortSignal.timeout(30000)}).then(response=>response.ok?response.json():null).catch(()=>null);
}
function prepareDiscordRestore(){
 if(!hasDiscordReturn())return null;
 const environment=readAuthEnvironment();
 let allowRestore, unsubscribe, cancelled=false;
 const restoreAllowed=new Promise(resolve=>{allowRestore=resolve;});
 const auth=loadFirebaseAuth().then(auth=>{
  if(!cancelled)unsubscribe=observeFirebaseAuth(auth,restoreAllowed);
  return auth;
 });
 auth.catch(()=>{});
 return {environment,auth,allowRestore,cancel(){
  cancelled=true;
  allowRestore(false);
  unsubscribe?.();
 }};
}
let discordRestore=prepareDiscordRestore();
function initAuth() {
 if(authEnvironment)return authEnvironment;
 document.getElementById('home-unauth-content').hidden=false;document.getElementById('home-auth-content').hidden=true;UserStore.isUserDataSyncDone=true;
 const resume=discordRestore;
 discordRestore=null;
 const preparation=(resume?.environment || readAuthEnvironment()).then(async environment=>{
  if(productionHost && (environment?.environment!=='production' || environment.authMode!=='firebase')){
   throw Error('운영 인증 상태를 확인하지 못했습니다.');
  }
  client.state.auth=environment?.authMode==='firebase'?'firebase':'demo';
  client.state.nameAutocompleteContinuation=environment?.nameAutocompleteContinuation===true;
  client.state.directLoginRead=productionHost && environment?.environment==='production'
   && environment.authMode==='firebase' && environment.loginReadDirectVersion===1;
  prepareLoginConnection();
  client.state.membershipProviders=environment?.membershipProviders || [];
  if(client.state.auth==='demo'){
   resume?.cancel();
   window.isAuthInitialized=true;
   if(client.state.token && !loginInProgress)serviceUiReady.then(()=>client.login()).catch(()=>{sessionStorage.removeItem('synapse-sql-ui-session');showLoading(false);});
   else checkAndHideInitialLoading();
   return;
  }
  client.state.token=null;
  sessionStorage.removeItem('synapse-sql-ui-session');
  if(productionHost)connectProductionServices();
  const auth=await (resume?.auth || loadFirebaseAuth());
  preparedFirebaseAuth=auth;
  if(resume)resume.allowRestore(true);
  else observeFirebaseAuth(auth);
  return auth;
 }).catch(()=>{
  resume?.cancel();
  if(authEnvironment!==preparation)return;
  authEnvironment=undefined;
  preparedFirebaseAuth=null;
  clearClientSession();
  serviceLoginFailureCode='AUTH_PREPARATION_FAILED';
  toggleAuthModal(true);
 });
 authEnvironment=preparation;
 return preparation;
}
async function preloadCard(cid, ids = []) {
 try {
  const card = await client.ensureCard(cid);
  const values = new Set([...ids.map(String), ...card.artworks.map(art => client.artSlot(card, { artworkId: art.id }))]);
  return await Promise.all([...values].map(id => preloadArtwork(cid, id)));
 } catch (_) { return []; }
}
let onboardingSync = Promise.resolve();
function syncOnboarding(value) {
 const token = client.state.token;
 if (!token || !client.state.preferences.onboarding) return Promise.resolve({pending:true});
 const keys = ['home','add','move','discard','inventory'];
 const patch = Object.fromEntries(keys.filter(key=>typeof value?.[key] === 'boolean').map(key=>[key,value[key]]));
 if (Object.keys(patch).every(key=>client.state.preferences.onboarding[key] === patch[key])) return Promise.resolve({success:true});
 onboardingSync = onboardingSync.catch(()=>{}).then(()=>token === client.state.token ? client.dispatch('updateUserSettings',{}, {settings:{onboarding:patch}}) : undefined);
 return onboardingSync;
}
let readSync = Promise.resolve();
function readNoticesStorageKey() {
 const key='ygo_synapse_read_notices:supabase:'+(client.state.profile?.userId && client.state.token ? client.state.profile.userId : 'guest');
 if(key.endsWith(':guest'))try{if(localStorage.getItem(key)===null){const legacy=localStorage.getItem('ygo_synapse_read_notices');if(legacy!==null)localStorage.setItem(key,legacy);}}catch(_){}
 return key;
}
function syncReadNotices(ids) {
 const token=client.state.token;
 // 구형 API에 미지원 필드를 보내지 않고, 적용된 bootstrap 응답부터 동기화한다.
 if(!token || !Array.isArray(client.state.preferences.readNotices))return Promise.resolve({pending:true});
 const patch=[...new Set(ids.filter(id=>typeof id==='string').map(id=>id.replace(/^(\d{4})-(\d{2})-(\d{2})T/,'$1.$2.$3T')).filter(id=>/^\d{4}\.\d{2}\.\d{2}T\d{2}:\d{2}$/.test(id)))].sort().reverse().slice(0,8);
 const same=patch.every(id=>client.state.preferences.readNotices.includes(id));
 if(same)return Promise.resolve({success:true});
 readSync=readSync.catch(()=>{}).then(()=>token===client.state.token?client.dispatch('updateUserSettings',{}, {settings:{readNotices:patch}}):undefined);
 return readSync;
}
function getCardLinkData(cid) {
 const card=client.state.cards.find(card=>card.cid===String(cid));
 return card?client.metadata(card).linkData:null;
}
async function signIn(providerName) {
 if(loginInProgress || registrationCheckPending)return;
 loginInProgress=true;
 serviceLoginFailureCode=null;
 setServiceLoginPending(true);
 toggleLoginBtn();
 try{
  const auth=preparedFirebaseAuth || await initAuth();
  if(client.state.auth==='demo')return await client.login();
  if(!auth)return;
  prepareLoginConnection(true);
  // Firebase 인증이 끝난 계정은 OAuth를 반복하지 않고 서비스 연결만 확인한다.
  if(auth.currentUser)return await openFirebaseSession(auth.currentUser);
  const provider=getProviderInstance(providerName);
  if(!provider)throw Error('로그인 방법을 선택해 주세요.');
  prepareLoginServer();
  root.YgoLoginTiming?.provider('popup');
  const popupTiming=providerName==='google'?root.YgoLoginTiming?.beginPopup():undefined;
  // 사용자가 시작한 같은 로그인에서만 증명을 미리 준비하고, 실패도 다음 단계에 그대로 전달한다.
  const warmup=getRegistrationAppCheck();loginAppCheckWarmup=warmup;warmup.catch(()=>{});
  let result;
  try{const pending=auth.signInWithPopup(provider);popupTiming?.returned();result=await pending;popupTiming?.settled(true);}
  catch(error){if(loginAppCheckWarmup===warmup)loginAppCheckWarmup=null;popupTiming?.settled(false);root.YgoLoginTiming?.cancelProvider();throw error;}
  if(auth.currentUser===result.user && pendingServiceAuthUser!==result.user)await openFirebaseSession(result.user);
 }catch(error){
  if(!registrationCheckPending && !UserStore.user){
   reportAuthFailure('sign-in-popup',error);
   serviceLoginFailureCode='PROVIDER_SIGN_IN_FAILED';
   toggleAuthModal(true);
  }
 }finally{
  loginInProgress=false;
  if(!registrationCheckPending)setServiceLoginPending(false);
  toggleLoginBtn();
 }
}
async function retrySignIn(){
 if(loginInProgress || registrationCheckPending || !preparedFirebaseAuth)return;
 const user=preparedFirebaseAuth.currentUser;
 if(!user || pendingServiceAuthUser!==user){toggleAuthModal();return;}
 return openFirebaseSession(user);
}
function clearClientSession({preserveLogin=false}={}){
 clearServiceRegistration();
 firebaseLoginTask=null;
 pendingServiceAuthUser=null;
 serviceLoginFailureCode=null;
 registrationCheckPending=false;
 const discordResult=document.getElementById('discord-restore-membership-result');
 if(discordResult){discordResult.hidden=true;discordResult.textContent='';}
 if(!preserveLogin){setServiceLoginPending(false);loginAppCheckWarmup=null;}
 client.state.token=null;client.state.firebaseUser=null;client.state.account=null;sessionStorage.removeItem('synapse-sql-ui-session');
 client.state.pending.clear();client.store.clear();client.state.cards=client.state.cards.filter(card=>!card.projectionOnly);applyServiceAuthState(null);applyMembershipStatus(null);refreshNoticeReadState();showLoading(false);
 toggleLoginBtn();
}
async function signOut(){
 if(client.state.auth==='firebase'){
  try{const auth=await authEnvironment;await auth?.signOut();}
  catch(_){showToast('로그아웃을 완료하지 못했습니다.','toast-warn');return;}
 }
 clearClientSession();
}
async function refreshInitialData() {await client.ready();UserStore.isInitialSyncDone=true;checkAndHideInitialLoading();}
function notifyUnavailable() {showToast('이 기능은 아직 Supabase API에 연결되지 않았습니다.', 'toast-warn');}
function unavailable() {return {success:false,isError:true,code:'FEATURE_NOT_CONNECTED',message:'이 기능은 아직 Supabase API에 연결되지 않았습니다.'};}

root.AppBackend = Object.freeze({
 id: 'supabase', cacheName: 'YgoSynapseSqlTrialDB',
 capabilities: Object.freeze({
  notices: true,
  get advertising(){return productionHost && client.state.auth==='firebase';},
  get accountDeletion(){return productionHost && client.state.auth==='firebase';},
  publicRefresh: false,
 }),
 syncOnboarding, readNoticesStorageKey, syncReadNotices, fetchNotices: () => client.dispatch('getNotices'),
 ready: client.ready, request: client.dispatch, initAuth, prepareSignIn, signIn, retrySignIn, signOut, refreshInitialData, notifyUnavailable,
 finishRegistration:client.loginFirebase,
 get inventoryState(){return {phase:client.store.root.session.phase,uid:client.store.root.session.uid,revision:client.state.profile?.revision,generation:client.state.generation,inventoryState:client.state.inventoryState};},
 getInventoryLocationNames:()=>client.state.locations.map(location=>location.name).sort(),
 membershipEnabled:provider=>Boolean(client.state.firebaseUser && client.state.membershipProviders?.includes(provider)),
 buildAuthPayload: () => ({}), refreshInventory: () => applyUserData(client.snapshot()),
 loadCatalog, prepareSuggestions, preloadArtwork, preloadCard, getCardLinkData, galleryEntries, galleryLabel, onSelectionChange,applyPhotoIllustration,
 getRegistrationOptions:client.registrationOptions, registrationSuggestions:client.registrationSuggestions, registrationNumber:client.registrationNumber,
 resolveDeckCardIds:client.resolveDeckCardIds, lookupPhotoCardNames:client.lookupPhotoCardNames, prepareMembershipEntry:client.prepareMembershipEntry, discordReturnSession,
 isQualifiedNumber:client.isQualifiedNumber, packSuggestions:client.packSuggestions, fetchPackPage:client.fetchPackPage,
});
})(globalThis);
