const { randomUUID } = require('node:crypto');
const active = new Set();
/** Storage 에뮬레이터가 generation 조건을 강제하지 않아 로컬 작성자들을 직렬화한다. */
async function withLocalNoticeLock(db, action) {
  const ref=db.collection('AdminNoticeLocks').doc('publication'),token=randomUUID();
  const alive=pid=>{if(!Number.isSafeInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
  active.add(token);
  let acquired=false;
  try {
  await db.runTransaction(async tx=>{
    const snap=await tx.get(ref),lock=snap.data();
    if(lock && (lock.pid===process.pid ? active.has(lock.token) : alive(lock.pid)))throw Object.assign(Error('다른 공지 작업이 진행 중입니다. 잠시 후 다시 조회해 주세요.'),{status:409});
    tx.set(ref,{pid:process.pid,token});
  });
  acquired=true;
  return await action();
  } finally {
    try {if(acquired)await db.runTransaction(async tx=>{const snap=await tx.get(ref);if(snap.data()?.token===token)tx.delete(ref);});}
    finally {active.delete(token);}
  }
}
module.exports={withLocalNoticeLock};
