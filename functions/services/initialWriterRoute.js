'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');

const requests = new AsyncLocalStorage();

// HTTP 진입 검사에서 확인한 route는 첫 업무 선택에 한 번만 전달한다.
// 읽기 후 epoch 검사·충돌 재시도·다음 요청은 이 값을 재사용하지 않는다.
async function withWriterRequestScope(action) {
  const routes = new Map();
  try { return await requests.run(routes, action); }
  finally { routes.clear(); }
}

function rememberInitialWriterRoute(transition, route) {
  requests.getStore()?.set(transition, route);
}

function withInitialWriterRoute(transition, route, action) {
  return withWriterRequestScope(() => {
    rememberInitialWriterRoute(transition, route);
    return action();
  });
}

function takeInitialWriterRoute(transition) {
  const routes = requests.getStore();
  const route = routes?.get(transition);
  routes?.delete(transition);
  return route;
}

module.exports = { withWriterRequestScope, rememberInitialWriterRoute, withInitialWriterRoute, takeInitialWriterRoute };
