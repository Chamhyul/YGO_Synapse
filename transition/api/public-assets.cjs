'use strict';
const path = require('node:path');
const { realpathSync } = require('node:fs');
const { realpath, stat } = require('node:fs/promises');

const types = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
});
const denied = new Set(['private', 'docs', 'node_modules', 'asset-manifest.json']);
function contentSecurityPolicy(pathname) {
  const ancestors = pathname === '/palette/specimen.html' ? "'self'" : "'none'";
  return "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/ https://apis.google.com; "
    + "style-src 'self' 'unsafe-inline'; connect-src 'self' https://firebaseappcheck.googleapis.com https://www.google.com/recaptcha/ https://identitytoolkit.googleapis.com https://securetoken.googleapis.com; "
    + "frame-src 'self' https://www.google.com/recaptcha/ https://recaptcha.google.com/recaptcha/ https://ygo-synapse.firebaseapp.com https://ygo-synapse.web.app; img-src 'self' data: blob:; "
    + "font-src 'self'; base-uri 'self'; frame-ancestors " + ancestors;
}
function publicPath(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch (_) { return null; }
  if (!/^\/[\w./-]*$/.test(decoded)) return null;
  const parts = decoded.split('/').filter(Boolean);
  if (parts.some(part => part.startsWith('.') || denied.has(part))) return null;
  return parts.join('/');
}

function createPublicAssets(webRoot) {
  const root = realpathSync(webRoot);
  return async pathname => {
    const name = publicPath(pathname);
    if (name === null) return null;
    try {
      let file = path.join(root, name);
      if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
      const type = types[path.extname(file)];
      if (!type) return null;
      const resolved = await realpath(file);
      if (!resolved.startsWith(root + path.sep) || !(await stat(resolved)).isFile()) return null;
      return { path: resolved, type };
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP'].includes(error.code)) return null;
      throw error;
    }
  };
}
module.exports = { createPublicAssets, publicPath, types, contentSecurityPolicy };
