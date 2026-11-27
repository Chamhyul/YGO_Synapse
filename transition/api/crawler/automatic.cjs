'use strict';
const {parseCatalog,parsePackPage}=require('./pack-parser.cjs');
const {checkedDate}=require('./release.cjs');
const ALL=['ko','ja','ae','cn','en','de','fr','it','es','pt'],QUICK=['ko','ja','en'];
const key=p=>p.locale+'/'+p.pid;
const needsReview=p=>!p||p.reported_card_count==null||(Number.isInteger(p.observed_card_count)&&(p.observed_card_count!==p.reported_card_count||p.positioned_count!==p.observed_card_count));
const safe=e=>e.message==='fetch failed'?'OFFICIAL_NETWORK_ERROR':['TimeoutError','AbortError'].includes(e.name)?'OFFICIAL_REQUEST_TIMEOUT':/^[A-Z0-9_]+$/.test(e.message)?e.message:'AUTOMATIC_CRAWL_FAILED';
const retryable=reason=>reason==='CRAWL_REQUEST_LIMIT'||reason==='OFFICIAL_NETWORK_ERROR'||reason==='OFFICIAL_REQUEST_TIMEOUT'||/^OFFICIAL_HTTP_5\d\d$/.test(reason);
function selectedLocales(mode){if(!['full','quick'].includes(mode))throw Error('INVALID_AUTOMATIC_MODE');return mode==='full'?[...ALL]:[...QUICK];}
function planTargets(catalogs,known,managed,locales){
 const targets=new Map(),done=new Map(known.map(p=>[key(p),p]));
 for(const locale of locales)for(const pack of catalogs[locale])if(needsReview(done.get(key(pack)))||managed[key(pack)]?.status!=='complete'&&managed[key(pack)])targets.set(key(pack),pack);
 // 카드 상세에서만 발견된 미발매 팩도 목록 등록 여부와 무관하게 재확인한다.
 for(const p of known)if(locales.includes(p.locale)&&needsReview(p)&&!targets.has(key(p)))targets.set(key(p),{pid:p.pid,locale:p.locale,name:p.name});
 for(const p of Object.values(managed))if(locales.includes(p.locale)&&p.status!=='complete'&&!targets.has(key(p)))targets.set(key(p),{pid:p.pid,locale:p.locale,name:p.name});
 return [...targets.values()].sort((a,b)=>(managed[key(a)]?.status==='collecting'?-1:0)-(managed[key(b)]?.status==='collecting'?-1:0)||locales.indexOf(a.locale)-locales.indexOf(b.locale)||a.pid.localeCompare(b.pid));
}
async function runAutomatic({mode,id,journal,loadKnown,fetchHtml,collectCard,store,finish,partial,guard=async()=>{},now=Date.now,workMs=3000000,planOnly=false,log=console.log,languages}){
 const defaults=selectedLocales(mode),locales=languages===undefined?defaults:languages;
 if(!Array.isArray(locales)||!locales.length||new Set(locales).size!==locales.length||locales.some(locale=>!ALL.includes(locale)))throw Error('INVALID_AUTOMATIC_LOCALES');
 if(!/^[a-z0-9-]{1,100}$/.test(id||''))throw Error('INVALID_AUTOMATIC_ID');
 const old=await journal.read('state');if(old&&(old.version!==1||!old.packs||old.kind!=='automatic-metadata'))throw Error('AUTOMATIC_STATE_MISMATCH');
 const state=old||{version:1,kind:'automatic-metadata',packs:{},createdAt:new Date(now()).toISOString()};
 const control=await journal.read('control');
 if(control?.stop)return {status:'stopped',mode};
 if(state.status==='paused'&&(!control?.resumeId||control.resumeId===state.resumeId))return {status:'paused',reason:state.reason,mode};
 if(control?.resumeId&&control.resumeId!==state.resumeId){state.resumeId=control.resumeId;delete state.reason;}
 const began=now(),room=()=>now()-began<workMs;
 const save=async()=>{state.updatedAt=new Date(now()).toISOString();await journal.write('state',state);};
 const summary={mode,id,locales,catalogs:{},targets:0,stored:0,complete:0,pending:0,review:0};
 const metadata=async url=>{await guard();const c=await journal.read('control');if(c?.stop)throw Error('USER_STOP_REQUESTED');return fetchHtml(url);};
 if(!planOnly){state.status='running';state.lastRun={...summary,startedAt:new Date(now()).toISOString()};await save();}
 try{
  const known=await loadKnown(),catalogs={};
  for(const locale of locales){catalogs[locale]=parseCatalog(await metadata('https://www.db.yugioh-card.com/yugiohdb/card_list.action?request_locale='+locale),locale);summary.catalogs[locale]=catalogs[locale].length;}
  const planned=planTargets(catalogs,known,state.packs,locales),cursor=planned.findIndex(p=>key(p)===state.nextTargets?.[mode]);
  const rotated=cursor<0?planned:[...planned.slice(cursor),...planned.slice(0,cursor)];
  const targets=[...rotated.filter(p=>state.packs[key(p)]?.status==='collecting'),...rotated.filter(p=>state.packs[key(p)]?.status!=='collecting')];summary.targets=targets.length;
  if(planOnly)return {...summary,status:'planned',targets:targets.map(p=>({...p,reason:known.some(k=>key(k)===key(p))?'incomplete_or_recheck':'new_pack'}))};
  const cached=new Map();let failures=0,packFailures=0;
  state.nextTargets||={};
  for(const [index,pack]of targets.entries()){
   if(!room())break;await guard();const k=key(pack),previous=state.packs[k];state.nextTargets[mode]=k;
   const advance=()=>{state.nextTargets[mode]=key(targets[(index+1)%targets.length]);};
   let p;
   try{
    const snapshot=parsePackPage(await metadata('https://www.db.yugioh-card.com/yugiohdb/card_search.action?'+new URLSearchParams({ope:'1',pid:pack.pid,request_locale:pack.locale,rp:'99999',sort:'1'})),pack,{allowPartial:true});
    // 시간 제한으로 중단된 팩만 이어받고, 대기/검토 팩은 매 회차 새 정보로 재확인한다.
    const resume=previous?.status==='collecting'&&JSON.stringify(previous.snapshot?.cids)===JSON.stringify(snapshot.cids)&&JSON.stringify(previous.snapshot?.publication)===JSON.stringify(snapshot.publication);
    p=state.packs[k]={...pack,status:'collecting',snapshot,cards:resume?previous.cards:{},checkedAt:new Date(now()).toISOString()};
    await journal.write('observations/'+id+'/packs/'+k,snapshot);await save();packFailures=0;
    if(!snapshot.cids.length){p.status=snapshot.publication.preview||snapshot.publication.announcedDate>checkedDate(now())?'pending_release':'review';p.reason='OFFICIAL_PACK_EMPTY_REVIEW_REQUIRED';summary[p.status==='review'?'review':'pending']++;advance();await save();continue;}
    for(const cid of snapshot.cids){
     if(!room())break;if(['stored','awaiting_publication'].includes(p.cards[cid]?.status))continue;
     await guard();const c=await journal.read('control');if(c?.stop)throw Error('USER_STOP_REQUESTED');
     const ck=pack.locale+'/'+cid;
     try{
      let result=cached.get(ck);
      if(!result){const value=await collectCard(cid,pack.locale,{partialPack:{pid:pack.pid,...snapshot.publication}});
       if(value.cid!==cid||value.pages.length!==1||value.pages[0].locale!==pack.locale||![...value.pages[0].rows,...(value.pages[0].pendingRows||[])].some(r=>r.pid===pack.pid))throw Error('AUTOMATIC_CARD_PACK_MISMATCH');
       await journal.write('observations/'+id+'/cards/'+ck,value);await guard();result=await store(value);cached.set(ck,result);summary.stored++;
      }
      p.cards[cid]={status:'stored',pendingReleases:result.pendingReleases||[]};failures=0;
     }catch(e){const reason=safe(e);if(retryable(reason)||['OFFICIAL_RATE_OR_ACCESS_DENIED','USER_STOP_REQUESTED','CRAWLER_LOCK_LOST'].includes(reason)||reason.startsWith('CHECKPOINT_')||e.code)throw e;
      const unpublished=snapshot.publication.preview||snapshot.publication.announcedDate>checkedDate(now());
      // 정확한 CID·언어의 공식 none 응답은 팩 제목의 미리보기 표시가
      // 없어도 상세 공개 대기로 보존한다. 손상된 페이지와는 구분한다.
      if(reason==='OFFICIAL_CARD_NOT_LISTED'||unpublished&&['OFFICIAL_CARD_CLASSIFICATION_MISSING','OFFICIAL_CARD_PAGE_INCOMPLETE','OFFICIAL_VARIANTS_EMPTY'].includes(reason)){p.cards[cid]={status:'awaiting_publication',reason};failures=0;}
      else{p.cards[cid]={status:'failed',reason};if(++failures>=3)throw Error('REPEATED_AUTOMATIC_CARD_ERRORS');}
     }
     await save();
    }
    if(!room()&&snapshot.cids.some(cid=>!p.cards[cid])){await save();break;}
    const missing=snapshot.cids.filter(cid=>!['stored','awaiting_publication'].includes(p.cards[cid]?.status));
    if(missing.length){p.status='review';p.reason='AUTOMATIC_CARDS_INCOMPLETE';p.missing=missing;summary.review++;advance();await save();continue;}
    const pending=snapshot.cids.filter(cid=>p.cards[cid].status==='awaiting_publication'||(p.cards[cid].pendingReleases||[]).some(r=>r.pid===pack.pid&&r.locale===pack.locale));
    p.pendingRows=snapshot.cids.reduce((n,cid)=>n+(p.cards[cid].pendingReleases||[]).filter(r=>r.pid===pack.pid&&r.locale===pack.locale).length,0);
    p.pendingCards=pending.length;
    const upcoming=snapshot.publication.announcedDate>checkedDate(now());
    if(snapshot.publication.preview||upcoming||pending.length){await partial(snapshot);p.status='pending_release';p.reason=snapshot.publication.preview?'OFFICIAL_SELECTED_CARD_PREVIEW':upcoming?'OFFICIAL_RELEASE_UPCOMING':pending.some(cid=>p.cards[cid]?.reason==='OFFICIAL_CARD_NOT_LISTED')?'OFFICIAL_CARD_DETAILS_UNAVAILABLE':'OFFICIAL_VARIANT_AWAITING_RELEASE';p.recheckOn=snapshot.publication.announcedDate||null;summary.pending++;}
    else{const result=await finish(snapshot);p.result=result;p.status=result.missing.length||result.extra.length?'review':'complete';summary[p.status==='complete'?'complete':'review']++;if(p.status==='complete')delete p.cards;}
    advance();await save();log(JSON.stringify({stage:'automatic-pack',pid:pack.pid,locale:pack.locale,status:p.status,pendingRows:p.pendingRows||0}));
   }catch(e){const reason=safe(e);if(retryable(reason)||['OFFICIAL_RATE_OR_ACCESS_DENIED','USER_STOP_REQUESTED','CRAWLER_LOCK_LOST','REPEATED_AUTOMATIC_CARD_ERRORS'].includes(reason)||reason.startsWith('CHECKPOINT_')||e.code)throw e;
    state.packs[k]={...(p||previous||pack),status:'review',reason,checkedAt:new Date(now()).toISOString()};summary.review++;advance();await save();if(++packFailures>=3)throw Error('REPEATED_AUTOMATIC_PACK_ERRORS');
   }
  }
  state.status='idle';state.lastRun={...summary,status:room()?'complete':'yielded',finishedAt:new Date(now()).toISOString()};await save();return state.lastRun;
 }catch(e){if(planOnly)throw e;const reason=safe(e);state.status=retryable(reason)?'idle':'paused';state.reason=reason;state.lastRun={...summary,status:reason==='CRAWL_REQUEST_LIMIT'?'yielded':retryable(reason)?'deferred':'paused',reason,finishedAt:new Date(now()).toISOString()};await save();log(JSON.stringify({stage:'automatic-stopped',reason,status:state.lastRun.status}));return state.lastRun;}
}
async function recordPartialPack(pool,pack){
 const c=await pool.connect();try{await c.query('begin');
  await c.query('insert into catalog.packs(pid,locale,name) values($1,$2,$3) on conflict(pid,locale) do nothing',[pack.pid,pack.locale,pack.name]);
  // 미리보기의 관측 개수를 전체 카드 수로 확정하지 않는다. 기존 확정 집계/순서는 유지.
  await c.query(`insert into catalog.pack_cards(pid,locale,cid,position) select $1,$2,x.cid,x.ordinality::integer from unnest($3::integer[])with ordinality x(cid,ordinality)
   join catalog.card_localizations l on l.cid=x.cid and l.locale=$2
   where (select reported_card_count is null from catalog.packs where pid=$1 and locale=$2)
   on conflict(pid,locale,cid) do update set position=excluded.position`,[pack.pid,pack.locale,pack.cids]);
  await c.query('commit');
 }catch(e){await c.query('rollback');throw e;}finally{c.release();}
}
module.exports={runAutomatic,planTargets,selectedLocales,recordPartialPack};
