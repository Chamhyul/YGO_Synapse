'use strict';
const cheerio=require('cheerio'),{clean,locales}=require('./parser.cjs');
const {officialDate}=require('./release.cjs');
function publicationStatus(title,locale){
 const preview=/preview|vista previa|amostra|prévia|anteprima|vorschau|aperçu|apercu|先行|一部.*公開|일부.*공개|미리보기|预览|預覽|抢先|搶先/i.test(title);
 let date=null,m=title.match(/(\d{4})[-/.年]\s*(\d{1,2})[-/.月]\s*(\d{1,2})/);
 if(m)date=officialDate(`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`);
 else if((m=title.match(/(\d{1,2})[/.]\s*(\d{1,2})[/.]\s*(\d{4})/))){const us=['en','ae'].includes(locale);date=officialDate(`${m[3]}-${m[us?1:2].padStart(2,'0')}-${m[us?2:1].padStart(2,'0')}`);}
 return {preview,announcedDate:date};
}
function parseCatalog(html,locale){
 if(!locales.includes(locale))throw Error('INVALID_CRAWL_TARGET');
 const $=cheerio.load(html),packs=new Map();
 if(!$('#card_list_1,#card_list_3,#update_list').length)throw Error('OFFICIAL_PACK_CATALOG_INCOMPLETE');
 $('.main').each((_,element)=>{const el=$(element),link=el.find('input.link_value').val();if(!link)return;
  const url=new URL(link,'https://www.db.yugioh-card.com'),pid=url.searchParams.get('pid'),name=clean(el.find('p').text());
  if(!pid||!/^\d{1,20}$/.test(pid)||!name)throw Error('OFFICIAL_PACK_ENTRY_INVALID');
  const previous=packs.get(pid);if(previous&&previous.name!==name)throw Error('OFFICIAL_PACK_NAME_CONFLICT');
  packs.set(pid,{pid,locale,name});
 });
 if(!packs.size)throw Error('OFFICIAL_PACK_CATALOG_EMPTY');return [...packs.values()];
}
function parsePackPage(html,pack,{allowPartial=false}={}){
 const $=cheerio.load(html),heading=$('#broad_title h1,.broad_title h1').clone();
 heading.find('rt,rp').remove();heading.find('br').replaceWith(' ');
 const title=clean(heading.text());
 if(!title||!$('#card_list').length)throw Error('OFFICIAL_PACK_PAGE_INCOMPLETE');
 let identity;try{identity=new URL($('meta[property="og:url"]').attr('content'));}catch{throw Error('OFFICIAL_PACK_IDENTITY_MISSING');}
 if(identity.origin!=='https://www.db.yugioh-card.com'||identity.pathname!=='/yugiohdb/card_search.action'
  ||identity.searchParams.get('ope')!=='1'||identity.searchParams.get('pid')!==pack.pid
  ||identity.searchParams.get('request_locale')!==pack.locale)throw Error('OFFICIAL_PACK_IDENTITY_MISMATCH');
 // rp=99999 요청에도 페이지 분할이 있으면 누락을 숨기지 않는다.
 const pageLinks=$('a[href]').toArray().map(e=>$(e).attr('href')).filter(v=>/\bpage=\d+/.test(v));
 if(pageLinks.some(v=>Number(new URL(v,'https://www.db.yugioh-card.com').searchParams.get('page'))>1))throw Error('OFFICIAL_PACK_PAGINATION_REVIEW_REQUIRED');
 const cids=[],rows=[];$('#card_list .t_row').each((_,element)=>{
  const el=$(element),links=el.find('input.link_value').toArray().map(e=>$(e).val()).filter(Boolean);
  const ids=[...new Set(links.map(v=>new URL(v,'https://www.db.yugioh-card.com').searchParams.get('cid')).filter(Boolean))];
  if(ids.length!==1||!/^\d{1,9}$/.test(ids[0]))throw Error('OFFICIAL_PACK_CARD_INCOMPLETE');
  const cid=Number(ids[0]);rows.push(cid);if(!cids.includes(cid))cids.push(cid);
 });
 // 0장은 미발매·페이지 변경·오류를 구분할 증거가 부족하므로 완료로 처리하지 않는다.
 const publication=publicationStatus(title,pack.locale);
 if(!cids.length&&!allowPartial)throw Error('OFFICIAL_PACK_EMPTY_REVIEW_REQUIRED');
 if(publication.preview&&!allowPartial)throw Error('OFFICIAL_PACK_PREVIEW_REVIEW_REQUIRED');
 return {...pack,cids,rowCount:rows.length,order:'official-card-number',publication,
  ...(title!==pack.name?{warnings:[{code:'OFFICIAL_PACK_TITLE_MISMATCH',expected:pack.name,actual:title}]}:{})};
}
module.exports={parseCatalog,parsePackPage,publicationStatus};
