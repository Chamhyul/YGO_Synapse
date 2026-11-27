'use strict';
function officialDate(value){
 const text=String(value||'').trim();
 if(!/^\d{4}-\d{2}-\d{2}$/.test(text))return null;
 const date=new Date(text+'T00:00:00Z');
 return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===text?text:null;
}
function checkedDate(now=new Date()){
 return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
}
function pendingReleases(snapshot){return snapshot.pages.flatMap(page=>(page.pendingRows||[]).map(row=>({...row,cid:snapshot.cid,locale:page.locale})));}
function pendingCids(cards,pid,locale){
 return [...new Set(Object.entries(cards).filter(([,c])=>(c.result?.pendingReleases||c.pendingReleases||[]).some(r=>r.pid===pid&&r.locale===locale)).map(([key,c])=>Number(c.cid||key.split('_')[0])))];
}
module.exports={officialDate,checkedDate,pendingReleases,pendingCids};
