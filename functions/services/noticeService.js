const { sanitizeNoticeHtml, sanitizeNoticeTitle } = require('./noticeContent');
const PATH = 'public/notices.json';
const idOf = n => String(n.id).replace(/^(\d{4})-(\d{2})-(\d{2})T/,'$1.$2.$3T');
const fail = (status, message) => Object.assign(new Error(message), { status });
function sorted(notices) {
  return notices.slice().sort((a,b) => {
    const ap = a.isPinned > 0, bp = b.isPinned > 0;
    return ap && bp ? a.isPinned - b.isPinned || idOf(b).localeCompare(idOf(a)) : ap ? -1 : bp ? 1 : idOf(b).localeCompare(idOf(a));
  });
}
function exposed(n) {
  const id=idOf(n);
  return { id, date:id.slice(0,10), title:sanitizeNoticeTitle(n.title), content:sanitizeNoticeHtml(n.content), isPinned:Number(n.isPinned)||0 };
}
function createNoticeService({storage,now=Date.now,environment='local',runLocked=action=>action()}) {
  async function read() {
    const result=await storage.read();
    const notices=result.data?.notices;
    if (!Array.isArray(notices) || notices.some(n=>!n || typeof n.id!=='string' || typeof n.title!=='string' || typeof n.content!=='string')
        || new Set(notices.map(n=>exposed(n).id)).size!==notices.length) throw fail(503,'공지 데이터를 읽을 수 없습니다.');
    return result;
  }
  const payload=r=>({revision:r.revision,notices:sorted(r.data.notices.map(exposed)),environment});
  return {
    async list(){return payload(await read());},
    preview({title,content}={}) {
      if(typeof title!=='string'||typeof content!=='string'||title.length>200||content.length>100000)throw fail(400,'제목은 200자, 본문은 100,000자 이내로 입력해 주세요.');
      return {title:sanitizeNoticeTitle(title),content:sanitizeNoticeHtml(content)};
    },
    async mutate(input,{requireRevision=true}={}) {
      return runLocked(async () => {
      const {action,id,revision}=input||{};
      if(!['add','update','delete'].includes(action))throw fail(400,'지원하지 않는 작업입니다.');
      if(requireRevision && (typeof revision!=='string'||!/^\d+$/.test(revision)))throw fail(400,'목록을 다시 조회해 주세요.');
      const current=await read();
      if(requireRevision && revision!==current.revision)throw fail(409,'다른 작업으로 공지가 변경됐습니다. 목록을 새로고침해 주세요.');
      const notices=current.data.notices.slice();
      const index=notices.findIndex(n=>exposed(n).id===id);
      if(action!=='add' && index<0)throw fail(404,'공지를 찾을 수 없습니다.');
      let notice;
      if(action==='delete')notices.splice(index,1);
      else {
        const original=action==='update'?notices[index]:{};
        const title=input.title===undefined?original.title:input.title;
        const content=input.content===undefined?original.content:input.content;
        if(typeof title!=='string'||typeof content!=='string'||title.length>200||content.length>100000)throw fail(400,'제목은 200자, 본문은 100,000자 이내로 입력해 주세요.');
        const safeTitle=sanitizeNoticeTitle(title);
        if(!safeTitle)throw fail(400,'제목을 입력해 주세요.');
        const pin=input.isPinned===undefined?(original.isPinned||0):Number(input.isPinned);
        if(!Number.isInteger(pin)||pin<0||pin>9999)throw fail(400,'고정 순위는 0부터 9999까지 정수로 입력해 주세요.');
        let noticeId=action==='update'?exposed(original).id:'';
        if(action==='add') {
          let time=Math.floor((now()+9*3600000)/60000)*60000;
          const ids=new Set(notices.map(n=>exposed(n).id));
          do {noticeId=new Date(time).toISOString().slice(0,16).replace(/-/g,'.');time+=60000;}while(ids.has(noticeId));
        }
        notice={...original,id:noticeId,date:noticeId.slice(0,10),title:safeTitle,content:sanitizeNoticeHtml(content),isPinned:pin};
        if(action==='add')notices.push(notice);else notices[index]=notice;
      }
      const next={...current.data,updatedAt:now(),notices:sorted(notices)};
      let nextRevision;
      try {nextRevision=await storage.write(next,current.revision);}catch(e){if(Number(e.code)===412)throw fail(409,'다른 작업으로 공지가 변경됐습니다. 목록을 새로고침해 주세요.');throw e;}
      return {...payload({data:next,revision:nextRevision}),action,...(notice?{notice:exposed(notice)}:{deletedId:id})};
      });
    }
  };
}
function createStorageNoticeStore(bucket) {
  return {
    async read() {
      const file=bucket.file(PATH);let metadata;
      try {[metadata]=await file.getMetadata();}catch(e){if(Number(e.code)===404)return {data:{notices:[]},revision:'0'};throw e;}
      const revision=String(metadata.generation);
      if(!/^\d+$/.test(revision))throw fail(503,'공지 버전을 확인할 수 없습니다.');
      const [content]=await bucket.file(PATH,{generation:revision}).download();
      return {data:JSON.parse(content.toString('utf8')),revision};
    },
    async write(data,revision) {
      const file=bucket.file(PATH);
      await file.save(JSON.stringify(data,null,2),{resumable:false,contentType:'application/json',public:true,
        preconditionOpts:{ifGenerationMatch:revision==='0'?0:revision},metadata:{cacheControl:'public, max-age=0, must-revalidate'}});
      // 저장 직후 다른 쓰기가 들어갈 수 있으므로 응답에 임의 최신 버전을 붙이지 않는다.
      // 클라이언트는 다음 편집 전에 목록을 다시 조회한다.
      return null;
    }
  };
}
module.exports={createNoticeService,createStorageNoticeStore};
