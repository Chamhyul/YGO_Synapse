const { onRequest } = require('firebase-functions/v2/https');
const fs = require('node:fs/promises');
const path = require('node:path');
const { admin, db } = require('../../config/firebase');
const { createAdminPageHandler, createFirestoreStore } = require('../../services/adminPageSession');
const { createErrorSummaryService } = require('../../services/adminErrorSummary');
const { createTrafficSummaryService } = require('../../services/adminTrafficSummary');
const { createNoticeService, createStorageNoticeStore } = require('../../services/noticeService');
const { createMembershipCsvService, createFirestoreMembershipCsvStore } = require('../../services/membershipCsvService');
const { createAdminProxy, createAdminBackendHandler, createLocalAdminRenderer, emulatorConfigured } = require('../../services/adminTransport');
const { google } = require('googleapis');
let productionHandler;
function production() {
  if (emulatorConfigured(process.env)) throw Error('운영 관리자 처리는 에뮬레이터에서 실행할 수 없습니다.');
  if (productionHandler) return productionHandler;
  // 운영 실행 계정의 ADC만 사용한다. 로컬 키 파일로 대체하는 경로는 없다.
  let analytics, reporting;
  const getTrafficSummary = createTrafficSummaryService({
    async run(requests) {
      if (!analytics) analytics = google.analyticsdata({ version: 'v1beta', auth: new google.auth.GoogleAuth({
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
      if (!reporting) reporting = google.clouderrorreporting({ version: 'v1beta1', auth: new google.auth.GoogleAuth({
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
  productionHandler = createAdminPageHandler({
    auth: admin.auth(), store: createFirestoreStore(db), getErrorSummary, getTrafficSummary,
    notices: createNoticeService({ storage: createStorageNoticeStore(admin.storage().bucket()), environment: 'production' }),
    membershipCsv: createMembershipCsvService({ store: createFirestoreMembershipCsvStore(db) }),
    template: name => fs.readFile(path.join(__dirname, '../../templates/admin', name + '.html'), 'utf8')
  });
  return productionHandler;
}
const proxy = createAdminProxy({ renderDocument: createLocalAdminRenderer(
  name => fs.readFile(path.join(__dirname, '../../templates/admin', name + '.html'), 'utf8')
) });
const options = { invoker: 'public', timeoutSeconds: 60, memory: '256MiB' };
// 로컬 관리자 경로는 페이지·세션·데이터 모두 운영 서버의 판정으로 연결한다.
exports.adminPages = onRequest(options, (req, res) => emulatorConfigured(process.env)
  ? proxy(req, res) : production()(req, res));
const backend = createAdminBackendHandler({ handler: (req, res) => production()(req, res) });
exports.adminBackend = onRequest(options, backend);
