/* 공지 편집은 서버 세션과 서버의 HTML 정리 결과만 사용한다. */
(() => {
    const content = document.getElementById('admin-content');
    const form = document.getElementById('notice-form');
    if (!content || content.hidden || !form) return;
    const get = id => document.getElementById('notice-' + id);
    let notices = [], revision = null, selected = null, baseline = '', busy = false, environment = '', ready = false;
    const fields = () => ({title:get('title').value, content:get('body').value, isPinned:Number(get('pin').value)});
    const dirty = () => JSON.stringify(fields()) !== baseline;
    const leave = () => !dirty() || window.confirm('저장하지 않은 변경을 버리시겠습니까?');
    function controls() {
        get('fields').disabled = busy || !ready;
        get('save').disabled = busy || revision === null;
        get('delete').disabled = busy || revision === null;
        get('new').disabled = busy || revision === null;
        get('reload').disabled = busy;
        get('list').setAttribute('aria-busy', String(busy));
        get('list').querySelectorAll('button').forEach(button => {button.disabled = busy || revision === null;});
    }
    function select(notice) {
        selected = notice?.id || null;
        get('title').value = notice?.title || '';get('body').value = notice?.content || '';get('pin').value = notice?.isPinned || 0;
        get('editor-title').textContent = notice ? '공지 수정' : '새 공지 작성';
        get('date').textContent = notice ? `등록일 ${notice.date} ${notice.id.slice(11)}` : '';
        get('delete').hidden = !notice;baseline = JSON.stringify(fields());
        get('preview-heading').textContent = '';get('preview-body').replaceChildren();renderList();
    }
    function renderList() {
        const query = get('search').value.trim().toLocaleLowerCase('ko-KR');
        const filtered = notices.filter(n => n.title.toLocaleLowerCase('ko-KR').includes(query));
        get('list').replaceChildren(...filtered.map((notice,index) => {
            const row = document.createElement('li'), label = document.createElement('span'), detail = document.createElement('span');
            label.className = 'admin-home-error-rank';label.textContent = String(index+1).padStart(2,'0');
            const button = document.createElement('button');button.type = 'button';button.className = `ui-button ${selected === notice.id ? 'color-theme' : 'color-type000'} shape-rounded-lg admin-home-record-link`;
            const title = document.createElement('span');title.textContent = notice.title;
            button.setAttribute('aria-pressed', String(selected === notice.id));button.addEventListener('click',()=>{if(!busy && leave())select(notice);});
            const info = document.createElement('span');info.textContent = `${notice.date} ${notice.id.slice(11)}${notice.isPinned>0?' · 고정 '+notice.isPinned:''}`;
            detail.append(title,info);button.append(label,detail);row.append(button);return row;
        }));
        get('empty').hidden = filtered.length > 0;
        get('empty').textContent = notices.length ? '검색 결과가 없습니다.' : '등록된 공지가 없습니다. 새 공지를 작성해 주세요.';
        controls();
    }
    async function request(path, body) {
        const controller = new AbortController(), timer = setTimeout(()=>controller.abort(),20000);
        try {
            const response = await fetch('/admin/api/notices'+path,{credentials:'same-origin',cache:'no-store',signal:controller.signal,
                ...(body ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {})});
            if (content.hidden) throw Error('화면이 종료되었습니다.');
            if(response.status===401 || response.status===403){content.hidden=true;window.location.reload();throw Error('로그인이 필요합니다.');}
            const data = await response.json();
            if(!response.ok || !data.success) {
                const error = Error([400,404,409].includes(response.status)?data.message || '입력 내용을 확인해 주세요.':'공지 작업을 완료할 수 없습니다.');
                error.status=response.status;throw error;
            }
            return data;
        } finally {clearTimeout(timer);}
    }
    function apply(data) {
        if(!Array.isArray(data.notices) || typeof data.revision!=='string')throw Error('목록을 읽을 수 없습니다.');
        notices=data.notices;revision=data.revision;environment=data.environment;ready=true;
        get('environment').textContent = environment === 'local' ? '로컬 테스트 · Storage 에뮬레이터에만 저장하며 운영 공지는 변경하지 않습니다.' : '운영 공지 · 로컬에서 접속해도 저장·삭제하면 실제 서비스에 반영됩니다.';
        renderList();
    }
    async function reload() {
        if(busy || !leave())return;
        busy=true;revision=null;controls();get('status').textContent='공지 목록을 조회하고 있습니다.';
        try {const data=await request('');if(content.hidden)return;apply(data);select(null);get('status').textContent='공지 목록을 불러왔습니다.';}
        catch {if(!content.hidden){get('status').textContent='공지 목록을 불러오지 못했습니다. 새로고침으로 다시 조회해 주세요.';get('empty').hidden=true;}}
        finally {busy=false;controls();}
    }
    async function mutate(action) {
        if(busy || revision===null)return;
        if(action==='delete' && !window.confirm(`“${get('title').value}” 공지를 삭제하시겠습니까?`))return;
        busy=true;controls();get('status').textContent='공지 작업을 저장하고 있습니다.';
        let saved=false;
        try {
            const result=await request('',{action,id:selected,revision,...(action==='delete'?{}:fields())});saved=true;
            revision=null;baseline=JSON.stringify(fields());
            const data=await request('');if(content.hidden)return;apply(data);
            select(action==='delete'?null:notices.find(n=>n.id===result.notice.id));
            get('status').textContent=action==='delete'?'공지를 삭제했습니다.':environment==='local'?'로컬 테스트 공지를 저장했습니다.':'공지를 저장했습니다.';
        }catch(error){
            if(content.hidden)return;
            if(error.status===409){revision=null;get('status').textContent='다른 작업으로 공지가 변경됐습니다. 작성 내용은 유지됩니다. 복사해 둔 뒤 새로고침해 주세요.';}
            else if(saved){revision=null;get('status').textContent='저장은 완료했지만 목록을 다시 읽지 못했습니다. 새로고침으로 결과를 확인해 주세요.';}
            else {if(error.status!==400)revision=null;get('status').textContent=(error.status===400?error.message:'저장 결과를 확인할 수 없습니다. 작성 내용은 유지됩니다. 새로고침으로 결과를 확인해 주세요.');}
        }finally {busy=false;controls();}
    }
    get('search').addEventListener('input',renderList);
    get('new').addEventListener('click',()=>{if(!busy && leave())select(null);});
    get('cancel').addEventListener('click',()=>{if(!busy && leave())select(selected?notices.find(n=>n.id===selected):null);});
    get('reload').addEventListener('click',reload);
    get('delete').addEventListener('click',()=>mutate('delete'));
    form.addEventListener('submit',event=>{event.preventDefault();if(form.reportValidity())mutate(selected?'update':'add');});
    get('preview-button').addEventListener('click',async()=>{
        if(busy)return;busy=true;controls();get('status').textContent='미리보기를 준비하고 있습니다.';
        try {const data=await request('/preview',fields());if(content.hidden)return;get('preview-heading').textContent=data.title;get('preview-body').innerHTML=data.content;get('status').textContent='미리보기입니다. 아직 저장하지 않았습니다.';}
        catch {if(!content.hidden)get('status').textContent='미리보기를 불러오지 못했습니다.';}
        finally {busy=false;controls();}
    });
    window.addEventListener('beforeunload',event=>{if((dirty()||busy) && !content.hidden){event.preventDefault();event.returnValue='';}});
    select(null);reload();
})();
