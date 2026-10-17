'use strict';
const express = require('express');
function createMainApp(env = process.env, { routes = null } = {}) {
  if (!env.GCLOUD_PROJECT || !env.STORAGE_BUCKET) throw new Error('기존 서비스 프로젝트와 버킷을 명시해야 합니다.');
  const functions = require('./index');
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => res.json({ success: true, service: 'main' }));
  app.use(express.json({ limit: '8mb' }));
  for (const [name, handler] of Object.entries(functions)) {
    if (!handler.__endpoint?.httpsTrigger || routes && !routes.has(name)) continue;
    app.all('/' + name, handler);
  }
  app.use((_req, res) => res.status(404).json({ success: false }));
  app.use((error, _req, res, _next) => res.status(error.type === 'entity.too.large' ? 413 : 400).json({ success: false }));
  return app;
}
if (require.main === module) {
  const server = createMainApp().listen(Number(process.env.PORT || 8080), '0.0.0.0', () => console.log('기존 서비스 준비 완료'));
  process.once('SIGTERM', () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 8000).unref();
  });
}
module.exports = { createMainApp };
