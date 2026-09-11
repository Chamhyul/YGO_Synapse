// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Mechanical staging of the currently deployed site plus this rollout's files.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {initializeStorage}=require('./upload_card_illustrations');
async function run(){
  const {admin}=initializeStorage('ygo-synapse.firebasestorage.app');
  const {access_token}=await admin.app().options.credential.getAccessToken();
  const headers={Authorization:`Bearer ${access_token}`};
  const base='https://firebasehosting.googleapis.com/v1beta1/';
  async function json(endpoint){const r=await fetch(base+endpoint,{headers});if(!r.ok)throw new Error(`Hosting HTTP ${r.status}`);return r.json();}
  const channel=await json('sites/ygo-synapse/channels/live');
  const version=channel.release.version.name;
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ygo-private-hosting-'));
  const publicDir=path.join(dir,'public');await fs.mkdir(publicDir);
  let nextPageToken;
  do{
    const page=await json(`${version}/files?pageSize=1000${nextPageToken?'&pageToken='+encodeURIComponent(nextPageToken):''}`);
    for(const file of page.files||[]){
      const name=file.path.replace(/^\//,'');
      if(name.split('/').includes('..'))throw new Error('Invalid path');
      const r=await fetch(`https://ygo-synapse.web.app/${name}`,{cache:'no-store'});
      if(!r.ok)throw new Error('Live asset unavailable');
      await fs.mkdir(path.dirname(path.join(publicDir,name)),{recursive:true});
      await fs.writeFile(path.join(publicDir,name),Buffer.from(await r.arrayBuffer()));
    }
    nextPageToken=page.nextPageToken;
  }while(nextPageToken);
  if((await json('sites/ygo-synapse/channels/live')).release.version.name!==version)throw new Error('Live release changed');
  const root=path.resolve(__dirname,'..');
  for(const name of ['illustration-images.js','search-illustrations.js','licenses.html','terms.html'])await fs.copyFile(path.join(root,'public',name),path.join(publicDir,name));
  await fs.cp(path.join(root,'public/legal'),path.join(publicDir,'legal'),{recursive:true});
  let html=await fs.readFile(path.join(publicDir,'index.html'),'utf8');
  html=html.replace(/illustration-images\.js\?[^"']*/g,'illustration-images.js?v=3-private-storage')
    .replace(/search-illustrations\.js\?[^"']*/g,'search-illustrations.js?v=7-private-storage')
    .replace(/(<a href="privacy\.html" class="footer-link-item"[^>]*>[^<]*<\/a>)/,
      '$1<span class="footer-link-separator">•</span><a href="licenses.html" class="footer-link-item">라이선스 및 출처</a>');
  await fs.writeFile(path.join(publicDir,'index.html'),html);
  const hosting=JSON.parse(await fs.readFile(path.join(root,'firebase.json'),'utf8')).hosting;
  await fs.writeFile(path.join(dir,'firebase.json'),JSON.stringify({hosting:{...hosting,public:'public'}}));
  console.log(JSON.stringify({directory:dir,previousVersion:version}));
}
run().catch(()=>{console.error('Hosting staging failed; sensitive details omitted.');process.exitCode=1});
