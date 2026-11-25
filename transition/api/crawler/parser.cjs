'use strict';
const cheerio=require('cheerio');
const {parseCardDetailHtml}=require('./metadata.generated.cjs');
const {toStoredInfo}=require('./schema.cjs');
const {officialDate,checkedDate}=require('./release.cjs');
const locales=['ko','ja','ae','cn','en','de','fr','it','es','pt'];
const clean=s=>String(s||'').normalize('NFC').replace(/\s+/gu,' ').trim();
function isNotListed(html,cid,locale){
 const $=cheerio.load(html),title=$('meta[name="title"]').attr('content')||'';
 let url;try{url=new URL($('meta[property="og:url"]').attr('content'));}catch{return false;}
 return /^none\s*\|/i.test(title)&&url.hostname==='www.db.yugioh-card.com'&&url.pathname==='/yugiohdb/card_search.action'
  &&url.searchParams.get('cid')===String(cid)&&url.searchParams.get('request_locale')===locale
  &&!$('.CardText, #update_list .t_row').length&&!clean($('.cardname h1, #cardname h1').text());
}
function parseCard(html,cid,locale,{now=new Date(),partialPack=null}={}){
 if(!/^\d+$/.test(String(cid))||!locales.includes(locale))throw Error('INVALID_CRAWL_TARGET');
 const $=cheerio.load(html),old=parseCardDetailHtml(html,locale);
 if(!old||!$('#update_list').length)throw Error('OFFICIAL_CARD_PAGE_INCOMPLETE');
 const common=toStoredInfo(old.mergedInfoSlot),localized=common[locale];delete common[locale];
 for(const field of ['atk','def','pendulum_scale'])if(common[field]==='?')common[field]=-1;
 // 링크의 DEF '-'는 0이나 '?'가 아니다. SQL에서는 적용할 값이 없는 null이다.
 if(common.properties?.includes('Link'))common.def=null;
 if(!['Monster','Spell','Trap'].includes(common.card_type)||!localized?.name)throw Error('OFFICIAL_CARD_CLASSIFICATION_MISSING');
 const rows=[],pendingRows=[],checkedOn=checkedDate(now),declared=new Set(localized.ciid||[]);
 $('#update_list .t_body > .t_row').each((index,element)=>{
  const el=$(element),link=el.find('.pack_name').parent().find('input.link_value').attr('value')||el.find('input.link_value').attr('value');
  if(!link)return;const url=new URL(link,'https://www.db.yugioh-card.com');
  const pid=url.searchParams.get('pid');if(!pid||!/^\d+$/.test(pid))throw Error('OFFICIAL_PACK_ID_MISSING');
  const raw=clean(el.find('.card_number').text());
  const rarityLabel=clean(el.find('.icon.rarity .lr_icon span').first().text());
  const displayCode=clean(el.find('.icon.rarity .lr_icon p').first().text());
  const rid=el.find('.icon.rarity .lr_icon').attr('class')?.match(/\brid_(\d+)\b/)?.[1];
  const ciid=Number(el.find('.card_img img').attr('id')?.match(/update_list_card_image_(\d+)/)?.[1]);
  const packLabel=el.find('.pack_name').clone();packLabel.find('rt,rp').remove();packLabel.find('br').replaceWith(' ');
  const releaseDate=officialDate(clean(el.find('.time').text()));
  const packPartial=partialPack?.pid===pid&&(partialPack.preview===true||officialDate(partialPack.announcedDate)>checkedOn);
  const future=Boolean(releaseDate&&releaseDate>checkedOn||packPartial);
  const missingFields=[];
  if(!rarityLabel)missingFields.push('rarityLabel');if(!displayCode)missingFields.push('displayCode');
  if(!Number.isInteger(ciid)||ciid<1)missingFields.push('ciid');
  else if(!declared.has(ciid))missingFields.push('artworkReference');
  if(future&&!raw)missingFields.push('number');
  const row={cid:Number(cid),locale,pid,packName:clean(packLabel.text()),number:raw?raw.toUpperCase():null,numberStatus:raw?'known':future?'unverified':'not_assigned',ciid:Number.isInteger(ciid)&&ciid>0?ciid:null,rarityLabel:rarityLabel||null,displayCode:displayCode||null,officialRid:rid?Number(rid):null,releaseDate};
  if(missingFields.length){
   if(!future)throw Error(missingFields.includes('artworkReference')?'OFFICIAL_ARTWORK_REFERENCE_MISSING':'OFFICIAL_VARIANT_INCOMPLETE');
   pendingRows.push({...row,rowIndex:index+1,missingFields,checkedOn,recheckOn:releaseDate||officialDate(partialPack?.announcedDate)||checkedOn,status:'awaiting_release',...(packPartial?{publicationPending:true}:{})});
  }else rows.push(row);
 });
 if(!rows.length&&!pendingRows.length)throw Error('OFFICIAL_VARIANTS_EMPTY');
 return {cid:Number(cid),locale,common,localized,rows,...(pendingRows.length?{pendingRows}:{})};
}
module.exports={parseCard,isNotListed,locales,clean};
