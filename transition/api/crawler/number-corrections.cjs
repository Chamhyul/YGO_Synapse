'use strict';

// 사용자 확정 보정. 공식 원문은 파서에 그대로 두고 저장 직전에만 적용한다.
// 언어·팩을 함께 제한하여 일본어의 정상 JP 번호를 보존한다.
const rules = [
  {locale:'ko',pids:['78809000'],from:'DP15-JP',to:'DP15-KR',digits:3},
  {locale:'ko',pids:['78812002','78812003'],from:'20AP-JP',to:'20AP-KR',digits:3},
  {locale:'de',pids:['23301000'],cid:4439,from:'SDY-G023',to:'SDY-G022'}
];

function correctPrintingNumber({cid,locale,pid,number}) {
  if (typeof number !== 'string') return number;
  for (const rule of rules) {
    if (locale!==rule.locale || !rule.pids.includes(String(pid)) || (rule.cid && Number(cid)!==rule.cid)) continue;
    if (rule.digits) {
      if (new RegExp('^'+rule.from+'[0-9]{'+rule.digits+'}$').test(number)) return rule.to+number.slice(rule.from.length);
    } else if (number===rule.from) return rule.to;
  }
  return number;
}

// 같은 규칙으로 전체 정합성 검사에서 미적용 번호를 찾는다.
function uncorrectedNumberCondition(alias='p') {
  if (!/^[a-z][a-z0-9_]*$/.test(alias)) throw Error('INVALID_NUMBER_CORRECTION_ALIAS');
  const quote=s=>"'"+s.replaceAll("'","''")+"'";
  return rules.map(rule=>'('+[
    `${alias}.locale=${quote(rule.locale)}`,
    `${alias}.pid in(${rule.pids.map(quote).join(',')})`,
    ...(rule.cid?[`${alias}.cid=${rule.cid}`]:[]),
    rule.digits?`${alias}.number ~ ${quote('^'+rule.from+'[0-9]{'+rule.digits+'}$')}`:`${alias}.number=${quote(rule.from)}`
  ].join(' and ')+')').join(' or ');
}

module.exports={correctPrintingNumber,uncorrectedNumberCondition};
