/* 소유자 화면의 계정 관리. 권한 판정·변경은 고정 운영 API만 수행한다. */
(() => {
    'use strict';
    const content=document.getElementById('admin-content');
    if(!content || content.hidden || content.dataset.adminRole!=='owner')return;
    const get=name=>document.getElementById('admin-accounts-'+name);
    const endpoint='https://asia-northeast3-ygo-synapse.cloudfunctions.net/manageAdminRole';
    let selected=null, busy=false, uncertain=false, pageToken=null;
    const controllers=new Set();
    const label={none:'일반 계정',admin:'관리자',owner:'소유자'};
    function controls(){
        const blocked=busy || content.hidden;
        get('fields').disabled=blocked;
        get('refresh').disabled=blocked;
        get('more').disabled=blocked;
        get('grant').disabled=blocked || uncertain || !selected || selected.disabled || selected.role!=='none' || selected.uid===content.dataset.adminUid;
        get('revoke').disabled=blocked || uncertain || !selected || selected.role!=='admin' || selected.uid===content.dataset.adminUid;
        get('list').querySelectorAll('button').forEach(button=>button.disabled=blocked);
        get('list').setAttribute('aria-busy',String(busy));
    }
    function showAccount(account){
        selected=account;uncertain=false;get('detail').hidden=!account;
        if(account){
            get('name').textContent=account.displayName || '표시 이름 없음';
            get('uid').textContent=account.uid;get('email').textContent=account.email || '등록된 이메일 없음';
            get('role').textContent=label[account.role]+(account.disabled?' · 사용 중지':'');
        }
        controls();
    }
    async function request(body){
        const user=firebase.auth().currentUser;
        if(!user || user.uid!==content.dataset.adminUid){content.hidden=true;throw Error('로그인 계정이 변경되었습니다. 새로고침해 주세요.');}
        const controller=new AbortController();controllers.add(controller);
        const timer=setTimeout(()=>controller.abort(),25000);
        try {
            const token=await user.getIdToken();
            if(content.hidden || firebase.auth().currentUser?.uid!==user.uid)throw Error();
            const response=await fetch(endpoint,{method:'POST',credentials:'omit',cache:'no-store',signal:controller.signal,redirect:'error',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body)});
            if(content.hidden || firebase.auth().currentUser?.uid!==user.uid)throw Error();
            const data=await response.json().catch(()=>({}));
            if(response.status===401 || response.status===403 && !['ADMIN_ACCOUNTS_OWNER_PROTECTED','ADMIN_ACCOUNTS_SELF_PROTECTED'].includes(data.code)){
                content.hidden=true;location.reload();throw Error();
            }
            if(!response.ok || !data.success)throw Object.assign(Error(data.code?.startsWith('ADMIN_ACCOUNTS_')?data.message:'계정 관리 요청을 완료하지 못했습니다. 서버 배포·연결 상태를 확인해 주세요.'),{status:response.status,code:data.code});
            return data;
        } finally {clearTimeout(timer);controllers.delete(controller);}
    }
    function status(message){if(!content.hidden)get('status').textContent=message;}
    async function loadList(append=false){
        if(busy || content.hidden)return;
        busy=true;controls();status('관리자 목록을 확인하고 있습니다.');
        try {
            const data=await request({action:'settingsList',...(append && pageToken?{pageToken}:{})});
            if(!Array.isArray(data.accounts))throw Error('관리자 목록 형식을 확인하지 못했습니다.');
            if(!append)get('list').replaceChildren();
            for(const account of data.accounts){
                const li=document.createElement('li'),button=document.createElement('button'),name=document.createElement('span'),description=document.createElement('span');
                button.type='button';button.className='ui-button ui-control--disabled color-disabled color-type000 shape-rounded-lg admin-account-row';
                name.textContent=account.displayName || account.email || account.uid;
                description.textContent=`${label[account.role]}${account.disabled?' · 사용 중지':''} · ${account.email || account.uid}`;
                button.append(name,description);button.addEventListener('click',()=>lookup('uid',account.uid));li.append(button);get('list').append(li);
            }
            pageToken=data.nextPageToken;get('more').hidden=!pageToken;
            get('empty').hidden=get('list').children.length>0;
            status(pageToken?'일부 계정을 조회했습니다. 더 불러오기로 다음 계정을 확인할 수 있습니다.':'관리자 목록을 확인했습니다.');
        }catch(error){status(error.message || '관리자 목록을 확인하지 못했습니다.');}
        finally{busy=false;controls();}
    }
    async function lookup(kind,value){
        if(busy || content.hidden)return;
        busy=true;showAccount(null);controls();status('계정을 조회하고 있습니다.');
        try{const data=await request({action:'settingsLookup',kind,value});showAccount(data.account);status('계정을 확인했습니다. UID와 이메일을 확인한 뒤 권한을 변경하세요.');}
        catch(error){status(error.message || '계정을 조회하지 못했습니다.');}
        finally{busy=false;controls();}
    }
    async function change(grant){
        if(busy || uncertain || !selected || content.hidden)return;
        if(!window.confirm(`${selected.email || selected.displayName || selected.uid}\nUID: ${selected.uid}\n\n관리자 권한을 ${grant?'부여':'해제'}할까요? 실제 운영 계정에 반영됩니다.`))return;
        busy=true;controls();status('관리자 권한을 변경하고 있습니다.');
        try {
            const data=await request({action:'settingsSetAdmin',targetUid:selected.uid,isAdmin:grant,expectedRole:selected.role});
            showAccount(data.account);status(`관리자 권한을 ${grant?'부여':'해제'}했습니다. 목록은 새로고침으로 확인할 수 있습니다.`);
        }catch(error){
            uncertain=true;
            status([400,403,404,409].includes(error.status)?error.message:'반영 결과를 확인하지 못했습니다. 다시 변경하지 말고 같은 계정을 조회해 현재 권한부터 확인해 주세요.');
        }finally{busy=false;controls();}
    }
    get('form').addEventListener('submit',event=>{event.preventDefault();if(get('form').reportValidity())lookup(get('kind').value,get('query').value.trim());});
    get('refresh').addEventListener('click',()=>loadList());get('more').addEventListener('click',()=>loadList(true));
    get('grant').addEventListener('click',()=>change(true));get('revoke').addEventListener('click',()=>change(false));
    new MutationObserver(()=>{if(content.hidden){for(const controller of controllers)controller.abort();showAccount(null);}}).observe(content,{attributes:true,attributeFilter:['hidden']});
    loadList();
})();
