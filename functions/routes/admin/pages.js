const { onRequest } = require('firebase-functions/v2/https');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createAdminRouteHandlers } = require('../../services/adminPageRuntime');
const { createAdminProxy, createLocalAdminRenderer } = require('../../services/adminTransport');
function productionDependencies() {
  // 실행 환경·RTDB 대상 검증을 통과하기 전에는 운영 SDK와 서비스를 만들지 않는다.
  const { admin, db } = require('../../config/firebase');
  const { createErrorSummaryService } = require('../../services/adminErrorSummary');
  const { createTrafficSummaryService } = require('../../services/adminTrafficSummary');
  const { createNoticeService, createStorageNoticeStore } = require('../../services/noticeService');
  // 기존 관리형 운영 실행 계정의 ADC를 사용하는 관리자 서비스 구성을 유지한다.
  // RTDB 연결의 metadata 자격증명 제한은 별도 userStorage 설정 계층에서 검사한다.
  let analytics, reporting;
  const getTrafficSummary = createTrafficSummaryService({
    async run(requests) {
      if (!analytics) analytics = require('googleapis/build/src/apis/analyticsdata').analyticsdata({ version: 'v1beta', auth: new (require('google-auth-library').GoogleAuth)({
        scopes: ['https://www.googleapis.com/auth/analytics.readonly']
      }) });
      const { data } = await analytics.properties.batchRunReports({
        property: 'properties/525013929', requestBody: { requests }
      }, { timeout: 10000 });
      return data;
    }
  });
  const getErrorSummary = createErrorSummaryService({
    async list({ period, pageToken }) {
      if (!reporting) reporting = require('googleapis/build/src/apis/clouderrorreporting').clouderrorreporting({ version: 'v1beta1', auth: new (require('google-auth-library').GoogleAuth)({
        scopes: ['https://www.googleapis.com/auth/cloud-platform']
      }) });
      const { data } = await reporting.projects.locations.groupStats.list({
        projectName: 'projects/ygo-synapse/locations/-', 'timeRange.period': period,
        'serviceFilter.resourceType': 'cloud_run_revision', pageSize: 100, order: 'COUNT_DESC',
        ...(pageToken ? { pageToken } : {})
      }, { timeout: 5000 });
      return data;
    }
  });
  const dependencies = {
    auth: admin.auth(), getErrorSummary, getTrafficSummary,
    notices: createNoticeService({ storage: createStorageNoticeStore(admin.storage().bucket()), environment: 'production' }),
    template: name => fs.readFile(path.join(__dirname, '../../templates/admin', name + '.html'), 'utf8')
  };
  const { createMembershipCsvService } = require('../../services/membershipCsvService');
  const { getMembershipCsvStore } = require('../../services/membershipCsvRepository');
  dependencies.membershipCsv = createMembershipCsvService({ store: getMembershipCsvStore({ db }) });
  return dependencies;
}
const proxy = createAdminProxy({ renderDocument: createLocalAdminRenderer(
  name => fs.readFile(path.join(__dirname, '../../templates/admin', name + '.html'), 'utf8')
) });
const options = { invoker: 'public', timeoutSeconds: 60, memory: '256MiB' };
// 기본 로컬 경로의 운영 proxy 계약은 유지한다. RTDB 에뮬레이터 의존성은 export에 주입하지 않는다.
const handlers = createAdminRouteHandlers({ productionDependencies, proxy });
exports.adminPages = onRequest(options, handlers.adminPages);
exports.adminBackend = onRequest(options, handlers.adminBackend);
