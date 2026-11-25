'use strict';
const { load } = require('cheerio');
const deck = require('../../functions/scrapers/deckScraper.js');
const { requestProduction } = require('../../functions/services/publicReadTransport.js');
const photoBodyLimit = 2 * 1024 * 1024;
const fail = (code,status) => Object.assign(Error(code),{status});

function deckDetailUrl(value) {
  if (typeof value !== 'string' || value.length>1024 || !deck.isAllowedDeckDetailUrl(value)) return false;
  return /^\/yugiohdb\/(?:member_deck|deck_search)\.action$/.test(new URL(value).pathname);
}

function createDeckSource(fetchImpl=fetch) {
  async function loadHtml(url,{ headers }) {
    if (!deckDetailUrl(url)) throw fail('INVALID_QUERY',400);
    const response = await fetchImpl(url,{headers,redirect:'error',signal:AbortSignal.timeout(15000)});
    if (!response.ok || !response.body) throw fail('DECK_UNAVAILABLE',503);
    const chunks=[];let size=0;
    for await (const chunk of response.body) {
      size+=chunk.length;
      if(size>2*1024*1024) throw fail('DECK_UNAVAILABLE',503);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const options={loadHtml,parseHtml:load};
  return {
    async search(code,locale) {
      if (!/^[a-z0-9_-]{1,64}$/i.test(code||'') || !['ko','ja','ae','cn','en','de','fr','it','es','pt'].includes(locale)) throw fail('INVALID_QUERY',400);
      const result=await deck.searchDeckByCode(code,locale,options);
      if (result.success && !deckDetailUrl(result.detailUrl)) throw fail('DECK_UNAVAILABLE',503);
      return result;
    },
    cards(url) {
      if (!deckDetailUrl(url)) throw fail('INVALID_QUERY',400);
      return deck.fetchDeckCards(url,options);
    },
  };
}

function validatePhoto(body) {
  const { images,maxResults=5 }=body;
  if (!Array.isArray(images) || images.length<1 || images.length>10
    || !Number.isInteger(maxResults) || maxResults<1 || maxResults>10
    || images.some(image=>typeof image!=='string' || !/^data:image\/jpeg;base64,[a-z0-9+/]+={0,2}$/i.test(image))) {
    throw fail('INVALID_PHOTO',400);
  }
  return {images,maxResults};
}

function analyzePhoto(body,headers) {
  return requestProduction('searchCardByImage',body,{headers});
}

module.exports={createDeckSource,validatePhoto,analyzePhoto,photoBodyLimit};
