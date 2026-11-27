'use strict';
// 초기 목록의 반복 필드명만 열 목록으로 공유한다. 값·필드·배열 순서는 보존한다.
function encodeCatalogRows(value){
 const schemas=[],known=new Map();
 const visit=value=>{
  if(Array.isArray(value)){
   const row=new Array(value.length+1);row[0]=-1;
   for(let i=0;i<value.length;i++)row[i+1]=visit(value[i]);
   return row;
  }
  if(value!==null&&typeof value==='object'){
   const keys=Object.keys(value);
   for(let i=keys.length-1;i>=0;i--)if(value[keys[i]]===undefined)keys.splice(i,1);
   // 같은 형태의 객체마다 전체 필드 목록을 문자열로 만들지 않는다.
   const signature=keys.length+':'+keys[0]+':'+keys[keys.length-1],bucket=known.get(signature)||[];
   let index;
   for(const candidate of bucket){
    const fields=schemas[candidate];let equal=true;
    for(let i=0;i<keys.length;i++)if(fields[i]!==keys[i]){equal=false;break;}
    if(equal){index=candidate;break;}
   }
   if(index===undefined){index=schemas.length;schemas.push(keys);bucket.push(index);known.set(signature,bucket);}
   const row=new Array(keys.length+1);row[0]=index;
   for(let i=0;i<keys.length;i++)row[i+1]=visit(value[keys[i]]);
   return row;
  }
  return value??null;
 };
 const data=visit(value);return{format:'schema-rows-v1',schemas,data};
}
module.exports={encodeCatalogRows};
