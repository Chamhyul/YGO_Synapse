// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Read deployed source generations; never export runtime environment values.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const cp=require('node:child_process'),crypto=require('node:crypto');
const {initializeStorage}=require('./upload_card_illustrations');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
async function run(){
  const root=path.resolve(__dirname,'..');
  const {admin}=initializeStorage('ygo-synapse.firebasestorage.app');
  const token=await admin.app().options.credential.getAccessToken();
  async function json(url){const r=await fetch(url,{headers:{Authorization:'Bearer '+token.access_token}});if(!r.ok)throw new Error('API HTTP '+r.status);return r.json();}
  const list=await json('https://cloudfunctions.googleapis.com/v2/projects/ygo-synapse/locations/asia-northeast3/functions?pageSize=1000');
  if(list.nextPageToken||!list.functions?.length)throw new Error('Incomplete function inventory');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ygo-deployed-sources-'));
  await fs.mkdir(path.join(dir,'functions-sources'));
  const knownSecrets=[];
  for(const file of ['functions/.env.local','functions/.secret.local']){
    try{for(const line of (await fs.readFile(path.join(root,file),'utf8')).split('\n')){
      const m=line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);if(m&&/SECRET|TOKEN|PASSWORD|PRIVATE_KEY/.test(m[1])){const v=m[2].trim().replace(/^(['"])(.*)\1$/,'$2');if(v.length>=8)knownSecrets.push(v);}
    }}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  const seen=new Map(),mapping=[];
  for(const f of list.functions){
    const source=f.buildConfig?.source?.storageSource;
    if(!source?.generation)throw new Error('Missing immutable source generation');
    const [bytes]=await admin.storage().bucket(source.bucket).file(source.object,{generation:source.generation}).download();
    const hash=sha(bytes),file=path.join(dir,'functions-sources',hash+'.zip');
    if(!seen.has(hash)){
      await fs.writeFile(file,bytes);
      await fs.chmod(file,0o600);
      const names=cp.execFileSync('unzip',['-Z1',file],{maxBuffer:4e6}).toString().trim().split('\n');
      const excluded=[];
      for(const name of names){
        if(name==='serviceAccountKey.json'){excluded.push(name);continue;}
        if(name.startsWith('/')||name.split('/').includes('..')||/(^|\/)(\.env(?:\.|$)|\.secret|\.git\/)|service.?account|\.(pem|p12|webp|jpe?g|png|sqlite|csv)$/i.test(name))throw new Error('Unsafe archive filename: '+name);
        if(name.endsWith('/'))continue;
        const b=cp.execFileSync('unzip',['-p',file,name],{maxBuffer:20e6});const s=b.toString();
        if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|GOCSPX-[\w-]{15,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}/.test(s)||knownSecrets.some(v=>s.includes(v)))throw new Error('Credential candidate in '+name);
      }
      if(excluded.length)cp.execFileSync('zip',['-d',file,...excluded],{stdio:'pipe'});
      const publicHash=sha(await fs.readFile(file));
      if(publicHash!==hash)await fs.rename(file,path.join(dir,'functions-sources',publicHash+'.zip'));
      seen.set(hash,{publicHash,excluded});
    }
    const sanitized=seen.get(hash);
    mapping.push({function:f.name.split('/').pop(),runtime:f.buildConfig.runtime,entryPoint:f.buildConfig.entryPoint,archive:'functions-sources/'+sanitized.publicHash+'.zip',sha256:sanitized.publicHash,originalSha256:hash,excludedPrivateFiles:sanitized.excluded,sourceGeneration:source.generation});
  }
  await fs.writeFile(path.join(dir,'FUNCTIONS.json'),JSON.stringify(mapping,null,2)+'\n');
  for(const name of ['LICENSE','ASSET_RIGHTS.md','THIRD_PARTY_NOTICES.md'])await fs.copyFile(path.join(root,name),path.join(dir,name));
  await fs.cp(path.join(root,'public/legal'),path.join(dir,'public/legal'),{recursive:true});
  console.log(JSON.stringify({directory:dir,functions:mapping.length,uniqueArchives:seen.size,credentialScan:'passed'}));
}
run().catch(e=>{console.error('Source preparation stopped: '+e.message);process.exitCode=1});
