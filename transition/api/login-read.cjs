'use strict';
// 인수는 저장소의 고정 SQL뿐이다. 미가입자의 보유 조회는 서버 안에서도 실행을 차단한다.
function createLoginReadQueries(stateSql,itemSelect){
 return [stateSql,`${itemSelect} where exists(select from (${stateSql}) registered_subject where registered)
   order by i.id`];
}
module.exports={createLoginReadQueries};
