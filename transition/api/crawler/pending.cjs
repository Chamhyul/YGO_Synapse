'use strict';
const {checkedDate,officialDate}=require('./release.cjs');
function pendingReport(records,{now=new Date()}={}){
 const checkedOn=checkedDate(now),entries=[];
 for(const record of records)for(const row of record.pendingReleases||record.result?.pendingReleases||[]){
  if(!officialDate(row.recheckOn))throw Error('PENDING_RELEASE_DATE_INVALID');
  entries.push({...row,status:row.recheckOn<=checkedOn?'due':'awaiting_release'});
 }
 entries.sort((a,b)=>a.recheckOn.localeCompare(b.recheckOn)||a.locale.localeCompare(b.locale)||a.cid-b.cid||a.rowIndex-b.rowIndex);
 return {checkedOn,cards:new Set(entries.map(r=>r.cid+':'+r.locale)).size,rows:entries.length,dueRows:entries.filter(r=>r.status==='due').length,entries};
}
async function main(){
 const id=process.argv[2];
 if(!/^[a-z0-9-]{1,80}$/.test(id||'')||process.env.CRAWL_STATE_BUCKET!=='ygo-synapse-transition-artworks')throw Error('PENDING_LIST_CONFIGURATION_REQUIRED');
 const bucket=new(require('@google-cloud/storage').Storage)().bucket(process.env.CRAWL_STATE_BUCKET),prefix='system/catalog-crawl/'+id+'/';
 const state=JSON.parse((await bucket.file(prefix+'state.json').download())[0]);let records;
 if(state.cards)records=Object.values(state.cards);
 else{
  const [files]=await bucket.getFiles({prefix:prefix+'cards/'});records=[];
  for(const file of files)if(file.name.endsWith('.ok.json')&&Number(file.metadata?.metadata?.pendingRows)>0)records.push(JSON.parse((await file.download())[0]));
 }
 console.log(JSON.stringify({runId:id,...pendingReport(records)}));
}
if(require.main===module)main().catch(e=>{console.error(JSON.stringify({code:/^[A-Z0-9_]+$/.test(e.message)?e.message:'PENDING_LIST_FAILED'}));process.exitCode=1;});
module.exports={pendingReport};
