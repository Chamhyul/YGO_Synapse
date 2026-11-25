'use strict';
const http = require('node:http');
const https = require('node:https');
const { readPublicNotices } = require('./notices.cjs');
const { readFile } = require('node:fs/promises');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createPublicAssets, contentSecurityPolicy } = require('./public-assets.cjs');

const previewOrigin = 'https://ygo-synapse--supabase-transition-k3pcjmzo.web.app';
const directPreviewOrigin = 'https://ygo-supabase-transition-271248187848.asia-northeast3.run.app';
const firebaseAppCheckAssets = new Set(['/__/firebase/13.0.0/firebase-app-compat.js',
  '/__/firebase/13.0.0/firebase-auth-compat.js',
  '/__/firebase/13.0.0/firebase-app-check-compat.js','/__/firebase/init.js']);

async function jsonBody(req, limit) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(Error('INVALID_COMMAND'), { status: 415 });
  if (Number(req.headers['content-length']) > limit) throw Object.assign(Error('INVALID_COMMAND'), { status: 413 });
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw Object.assign(Error('INVALID_COMMAND'), { status: 413 });
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  let value;
  try { value = JSON.parse(body); } catch (_) { throw Object.assign(Error('INVALID_COMMAND'), { status: 400 }); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(Error('INVALID_COMMAND'), { status: 400 });
  return body;
}

function fetchEncodedResponse(url, { headers, signal, method='GET', body }) {
  // fetch()은 본문을 자동으로 풀기 때문에 원격 전송 바이트는 HTTPS 스트림으로 읽는다.
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method,headers,signal }, response => {
      resolve({ status: response.statusCode, headers: new Headers(response.headers), body: Readable.toWeb(response) });
    });
    request.once('error', reject);
    request.end(body);
  });
}

function createLocalPreview({
  webRoot = process.env.TRANSITION_WEB_ROOT || '/app/web',
  upstreamOrigin = process.env.TRANSITION_REMOTE_API_ORIGIN || previewOrigin,
  allowedOrigins = (process.env.TRANSITION_ALLOWED_ORIGINS || 'http://localhost:5005,http://127.0.0.1:5005').split(','),
  fetchImpl = fetch,
  fetchEncodedImpl = fetchEncodedResponse,
} = {}) {
  // 데이터는 고정 Supabase 시험 API, 공지는 notices.cjs의 고정 공개 원본만 읽는다.
  if (upstreamOrigin !== previewOrigin) throw Error('INVALID_PREVIEW_API_ORIGIN');
  const findAsset = createPublicAssets(webRoot);
  const server = http.createServer(async (req, res) => {
    let remoteController, remoteDeadline;
    const cancelRemote = () => {
      if (!res.writableFinished) remoteController?.abort();
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', contentSecurityPolicy('/'));
    const json = (status, code) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ success: false, code })); };
    try {
      const url = new URL(req.url, 'http://localhost');
      res.setHeader('Content-Security-Policy', contentSecurityPolicy(url.pathname));
      const file = ['GET', 'HEAD'].includes(req.method) ? await findAsset(url.pathname) : null;
      if (file) {
        const body = req.method === 'HEAD' ? undefined : await readFile(file.path);
        res.writeHead(200, { 'Content-Type': file.type }); return res.end(body);
      }
      const firebaseAsset = req.method==='GET' && firebaseAppCheckAssets.has(url.pathname);
      if (!firebaseAsset && url.pathname !== '/healthz' && !url.pathname.startsWith('/api/v2/')) return json(404, 'NOT_FOUND');
      if (req.headers.origin) {
        if (!allowedOrigins.includes(req.headers.origin)) return json(403, 'ORIGIN_DENIED');
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Firebase-AppCheck' }); return res.end();
      }
      if (!['GET', 'POST'].includes(req.method)) return json(405, 'METHOD_NOT_ALLOWED');
      if (url.pathname === '/api/v2/notices') {
        if (req.method !== 'GET') return json(405, 'METHOD_NOT_ALLOWED');
        const value = await readPublicNotices(fetchImpl);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(value));
      }
      const headers = { Accept: req.headers.accept || 'application/json' };
      if (!firebaseAsset && req.headers.authorization) headers.Authorization = req.headers.authorization;
      const photo = url.pathname === '/api/v2/searchCardByImage';
      const membership=/^\/api\/v2\/membership\/(discord|youtube)\/(start|verify)$/.test(url.pathname);
      if ((photo || membership || ['/api/v2/searchDeck','/api/v2/getDeckCards','/api/v2/catalog/registration','/api/v2/catalog/inventory-batches','/api/v2/registration','/api/v2/checkSheet','/api/v2/clearUserData'].includes(url.pathname)) && req.headers['x-firebase-appcheck']) {
        headers['X-Firebase-AppCheck']=req.headers['x-firebase-appcheck'];
      }
      const limit = { '/api/v2/migrateFromData':8*1024*1024, '/api/v2/searchCardByImage':2*1024*1024,
        '/api/v2/inventory/add-batch':256*1024 }[url.pathname] || 16384;
      const body = req.method === 'POST' ? await jsonBody(req, limit) : undefined;
      if (body) {
        headers['Content-Type'] = 'application/json';
        // 들어오는 Origin은 위에서 검사하고, 고정 시험 API의 기존 Origin 계약으로 전달한다.
        headers.Origin = upstreamOrigin;
      }
      // Hosting은 /api/**만 원격 API로 제공하므로 health는 공개 환경 경로로 확인한다.
      const upstreamPath = url.pathname === '/healthz' ? '/api/v2/environment' : url.pathname + (firebaseAsset?'':url.search);
      remoteController = new AbortController();
      remoteDeadline = setTimeout(() => remoteController.abort(new DOMException('Preview API timeout', 'TimeoutError')), photo?45000:25000);
      res.once('close', cancelRemote);
      const packDetail = req.method === 'GET' && /^\/api\/v2\/packs\/[a-z0-9-]{1,40}\/cards$/i.test(url.pathname);
      const packLookup = url.pathname === '/api/v2/packs'
        || /^\/api\/v2\/packs\/[a-z0-9-]{1,40}\/cids$/i.test(url.pathname);
      const directPublicRead = req.method === 'GET' && req.headers.authorization === undefined
        && (packLookup || packDetail || url.pathname === '/api/v2/packs/suggestions'
          || (url.pathname === '/api/v2/search' && url.searchParams.get('mode') === 'autocomplete'));
      const upstreamUrl = new URL(upstreamPath, directPublicRead ? directPreviewOrigin : upstreamOrigin);
      const encodedJson=packDetail || (req.method==='POST' && ['/api/v2/catalog/registration','/api/v2/catalog/inventory-batches'].includes(url.pathname))
        || (req.method==='GET' && ['/api/v2/bootstrap','/api/v2/registration'].includes(url.pathname));
      if (encodedJson) {
        headers['Accept-Encoding'] = req.headers['accept-encoding'] || 'identity';
        res.appendHeader('Vary', 'Accept-Encoding');
      }
      const upstream = encodedJson
        ? await fetchEncodedImpl(upstreamUrl, { method:req.method,headers,body,signal:remoteController.signal })
        : await fetchImpl(upstreamUrl, {
          method: req.method, headers, body, redirect: 'manual', signal: remoteController.signal,
        });
      // 응답 헤더를 기다리는 동안 브라우저가 떠났다면 스트림을 연결하지 않는다.
      if (res.destroyed || remoteController.signal.aborted) {
        await upstream.body?.cancel().catch(() => {}); return;
      }
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel(); return json(502, 'PREVIEW_API_REDIRECT');
      }
      const responseHeaders = ['content-type', 'cache-control', 'server-timing'];
      if (encodedJson) responseHeaders.push('content-encoding', 'content-length');
      for (const name of responseHeaders) {
        const value = upstream.headers.get(name); if (value) res.setHeader(name, value);
      }
      res.writeHead(upstream.status);
      if (!upstream.body) return res.end();
      const source = Readable.fromWeb(upstream.body);
      // 취소 직후 pipeline 정리가 끝난 뒤 발생하는 스트림 오류도 요청 안에서 처리한다.
      source.on('error', () => {});
      await pipeline(source, res, { signal: remoteController.signal });
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) return res.destroy();
      return json(error.status || 502, error.message === 'NOTICE_UNAVAILABLE' ? 'NOTICE_UNAVAILABLE' : error.status ? 'INVALID_COMMAND' : 'PREVIEW_API_UNAVAILABLE');
    } finally {
      clearTimeout(remoteDeadline);
      res.removeListener('close', cancelRemote);
      remoteController?.abort();
    }
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 20000;
  return { server, close: () => new Promise(resolve => server.close(resolve)) };
}

if (require.main === module) {
  const app = createLocalPreview();
  app.server.listen(Number(process.env.PORT || 8080), '0.0.0.0', () => process.stdout.write('로컬 UI · Supabase 시험 API 연결 준비 완료\n'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => app.close().then(() => process.exit(0)));
}
module.exports = { createLocalPreview, previewOrigin };
