'use strict';
const {parseCard,isNotListed,locales}=require('./parser.cjs');
function createLimiter({intervalMs=3000,maxRequests=200,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),initialDelay=false}={}){
 if(intervalMs<3000||!Number.isSafeInteger(maxRequests)||maxRequests<1||maxRequests>10000)throw Error('INVALID_CRAWL_LIMIT');
 let previous=initialDelay?now():null,requests=0,tail=Promise.resolve();
 return {wait(){const next=tail.then(async()=>{if(requests>=maxRequests)throw Error('CRAWL_REQUEST_LIMIT');
  if(previous!==null){const delay=Math.max(0,previous+intervalMs-now());if(delay)await sleep(delay);}previous=now();requests++;});tail=next.catch(()=>{});return next;},get requests(){return requests;}};
}
async function requestHtml(url,{limiter,fetchPage=fetch}={}){
 const target=new URL(url);
 if(target.origin!=='https://www.db.yugioh-card.com'||!['/yugiohdb/card_list.action','/yugiohdb/card_search.action'].includes(target.pathname))throw Error('OFFICIAL_METADATA_URL_REQUIRED');
 await limiter.wait();
 const response=await fetchPage(url,{redirect:'error',signal:AbortSignal.timeout(25000),headers:{'User-Agent':'YGO-Synapse-Catalog/1.0'}});
 if(response.status===403||response.status===429)throw Error('OFFICIAL_RATE_OR_ACCESS_DENIED');
 if(!response.ok)throw Error('OFFICIAL_HTTP_'+response.status);
 const body=await response.text();if(Buffer.byteLength(body)>5*1024*1024)throw Error('OFFICIAL_RESPONSE_TOO_LARGE');return body;
}
async function collect(cid,{languages=locales,onProgress=()=>{},fetchPage=fetch,intervalMs=3000,maxRequests=20,limiter,partialPack=null}={}){
 if(!Number.isSafeInteger(maxRequests)||maxRequests<1||maxRequests>1000||intervalMs<3000)throw Error('INVALID_CRAWL_LIMIT');
 limiter ||=createLimiter({intervalMs,maxRequests});const pages=[],notListed=[];
 for(const locale of languages){
  const url=`https://www.db.yugioh-card.com/yugiohdb/card_search.action?ope=2&cid=${cid}&request_locale=${locale}`;
  const body=await requestHtml(url,{limiter,fetchPage});
  if(isNotListed(body,cid,locale)){notListed.push(locale);onProgress({locale,status:'not_listed'});continue;}
  const page=parseCard(body,cid,locale,{partialPack});pages.push(page);onProgress({locale,rows:page.rows.length});
 }
 if(!pages.length)throw Error('OFFICIAL_CARD_NOT_LISTED');
 return {cid:Number(cid),pages,notListed};
}
module.exports={collect,createLimiter,requestHtml};
