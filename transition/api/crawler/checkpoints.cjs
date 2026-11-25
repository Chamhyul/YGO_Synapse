'use strict';
const TRANSIENT=new Set([408,429,500,502,503,504,'ECONNRESET','ETIMEDOUT','EAI_AGAIN']);
function failure(operation,key,error,attempts){
 const e=Error('CHECKPOINT_'+operation+'_FAILED');
 e.details={operation,key,attempts,sourceCode:String(error.code??'UNKNOWN'),sourceName:error.name||'Error',
  reasons:(error.errors||[]).map(v=>v.reason).filter(v=>/^[a-zA-Z0-9_-]{1,80}$/.test(v||''))};return e;
}
function createJournal({bucket,prefix,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),intervalMs=1250,maxAttempts=5}){
 const last=new Map();let tail=Promise.resolve();
 const valid=key=>{if(!/^[a-z0-9/_-]+(?:\.ok|\.error)?$/.test(key))throw Error('INVALID_CHECKPOINT_KEY');};
 return {
  async read(key){valid(key);for(let n=1;;n++)try{
   const [body]=await bucket.file(prefix+key+'.json').download();
   try{return JSON.parse(body);}catch{const e=Error('CHECKPOINT_JSON_INVALID');e.details={operation:'READ',key};throw e;}
  }catch(e){if(Number(e.code)===404)return null;if(e.message==='CHECKPOINT_JSON_INVALID')throw e;
   if(!TRANSIENT.has(Number(e.code))&&!TRANSIENT.has(e.code)||n>=maxAttempts)throw failure('READ',key,e,n);
   await sleep(Math.min(30000,1000*2**(n-1)));
  }},
  write(key,value,{once=false,metadata={}}={}){
   valid(key);const body=JSON.stringify(value);
   const work=tail.then(async()=>{for(let n=1;;n++){
    if(last.has(key)){const wait=last.get(key)+intervalMs-now();if(wait>0)await sleep(wait);}
    last.set(key,now());
    try{await bucket.file(prefix+key+'.json').save(body,{resumable:false,contentType:'application/json',metadata:{metadata},...(once?{preconditionOpts:{ifGenerationMatch:0}}:{})});return;}
    catch(e){if(once&&Number(e.code)===412)return;
     if(!TRANSIENT.has(Number(e.code))&&!TRANSIENT.has(e.code)||n>=maxAttempts)throw failure('WRITE',key,e,n);
     await sleep(Math.min(30000,1000*2**(n-1)));
    }
   }});tail=work.catch(()=>{});return work;
  }
 };
}
module.exports={createJournal};
