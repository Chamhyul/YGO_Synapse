'use strict';
const { createReadApp } = require('./app');
const { createBackend } = require('./backend');
const { createAuthenticator } = require('./auth');
const app = createReadApp({ ...createBackend(process.env), authenticate: createAuthenticator(process.env) });
const server = app.listen(Number(process.env.PORT || 8080), '0.0.0.0', () => console.log('카드 읽기 서비스 준비 완료'));
process.once('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8000).unref();
});
