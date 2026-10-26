/** GA4 집계값만 제공한다. 사용자·URL·계정 차원은 응답/로그에 전달하지 않는다. */
const CACHE_MS = 60000;
const METRICS = ['activeUsers', 'sessions', 'screenPageViews'];
const HOSTNAME = 'ygo-synapse.web.app';
const { measure, recordTrafficFailure, recordTrafficSchema } = require('./adminRequestTiming');
const DETAIL = Symbol('traffic-failure');
const failure = (category, detail = {}) => Object.assign(Error('traffic-validation-failed'), { [DETAIL]: { category, ...detail } });
function upstreamFailure(error) {
  const status = error?.response?.status;
  const reasons = (Array.isArray(error?.response?.data?.error?.details) ? error.response.data.error.details : []).map(value => value?.reason);
  const category = reasons.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT') ? 'UPSTREAM_SCOPE'
    : reasons.includes('SERVICE_DISABLED') ? 'UPSTREAM_DISABLED'
    : status === 401 || status === 403 ? 'UPSTREAM_PERMISSION'
    : status === 429 ? 'UPSTREAM_QUOTA'
    : ['ETIMEDOUT', 'ECONNABORTED', 'ERR_SOCKET_CONNECTION_TIMEOUT'].includes(error?.code) ? 'UPSTREAM_TIMEOUT'
    : ['ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].includes(error?.code) ? 'UPSTREAM_NETWORK'
    : Number.isInteger(status) ? 'UPSTREAM_HTTP' : 'UPSTREAM_UNKNOWN';
  return failure(category, { httpStatus: status });
}
function koreanDate(time) {
  return new Date(time + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function shiftDate(date, days) {
  return new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}
function count(value) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw failure('COUNT_VALUE');
  return Number(value);
}
function headerIndexes(headers, expected, category, slot) {
  if (!Array.isArray(headers) || headers.length !== expected.length) throw failure(category, { report: slot });
  const names = headers.map(header => header?.name);
  if (new Set(names).size !== expected.length || names.some(name => !expected.includes(name))) throw failure(category, { report: slot });
  return expected.map(name => names.indexOf(name));
}
function checkReport(report, metrics, dimensions, slot) {
  if (!report) throw failure('REPORT_MISSING', { report: slot });
  recordTrafficSchema(slot, report);
  if (report.metadata?.timeZone !== 'Asia/Seoul') throw failure('TIMEZONE_MISMATCH', { report: slot, timeZone: report.metadata?.timeZone });
  // protobuf JSON은 0행 보고서의 빈 repeated 필드를 생략할 수 있다.
  // 성공한 정식 보고서·서울 시간대·0행·모든 데이터/헤더 열 부재가 함께 확인될 때만 허용한다.
  const emptyArray = value => value === undefined || Array.isArray(value) && value.length === 0;
  if (report.kind === 'analyticsData#runReport' && (report.rowCount === undefined || report.rowCount === 0)
      && ['rows', 'metricHeaders', 'dimensionHeaders', 'totals', 'maximums', 'minimums'].every(key => emptyArray(report[key]))) {
    return { metricIndexes: [], dimensionIndexes: [] };
  }
  const metricIndexes = headerIndexes(report.metricHeaders || [], metrics, 'METRIC_HEADERS', slot);
  const dimensionIndexes = headerIndexes(report.dimensionHeaders || [], dimensions, 'DIMENSION_HEADERS', slot);
  if ((report.rowCount || 0) !== (report.rows || []).length) throw failure('ROW_COUNT', { report: slot });
  return { metricIndexes, dimensionIndexes };
}
function createTrafficSummaryService({ run, now = Date.now }) {
  let cached, pending, retryAt = 0;
  async function load() {
    const today = koreanDate(now()), yesterday = shiftDate(today, -1), start = shiftDate(today, -29);
    const filter = { andGroup: { expressions: [
      { filter: { fieldName: 'hostName', stringFilter: { matchType: 'EXACT', value: HOSTNAME, caseSensitive: false } } },
      { notExpression: { filter: { fieldName: 'pagePath', stringFilter: { matchType: 'PARTIAL_REGEXP', value: '^/admin(?:/|$|\\.html$)', caseSensitive: false } } } }
    ] } };
    const request = (from, to, metrics, dimensions = []) => ({dateRanges:[{startDate:from,endDate:to}],
      metrics:metrics.map(name=>({name})),dimensions:dimensions.map(name=>({name})),dimensionFilter:filter,limit:'30'});
    let response;
    try { response = await measure('admin.traffic.ga', () => run([request(today,today,METRICS),request(yesterday,yesterday,METRICS),request(start,today,['activeUsers'],['date'])])); }
    catch (error) { throw upstreamFailure(error); }
    return measure('admin.traffic.validate', () => {
    try {
    if (response.reports?.length !== 3) throw failure('REPORTS_MISSING');
    const [current, previous, trend] = response.reports;
    const currentColumns = checkReport(current,METRICS,[],'current');
    const previousColumns = checkReport(previous,METRICS,[],'previous');
    const trendColumns = checkReport(trend,['activeUsers'],['date'],'trend');
    const summary = (report, columns) => {
      if ((report.rows || []).length > 1) throw failure('SUMMARY_ROWS');
      if (!(report.rows || []).length) return Object.fromEntries(METRICS.map(m=>[m,0]));
      const values = report.rows[0].metricValues;
      if (values?.length !== 3) throw failure('METRIC_VALUES');
      return Object.fromEntries(METRICS.map((m,i)=>[m,count(values[columns.metricIndexes[i]].value)]));
    };
    const daily = new Map();
    for (const row of trend.rows || []) {
      const raw = row.dimensionValues?.[trendColumns.dimensionIndexes[0]]?.value;
      if (!/^\d{8}$/.test(raw) || row.dimensionValues.length !== 1 || row.metricValues?.length !== 1) throw failure('DATE_VALUE', { report: 'trend' });
      const date = `${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}`;
      if (date < start || date > today || shiftDate(date,0) !== date || daily.has(date)) throw failure('DATE_RANGE', { report: 'trend' });
      daily.set(date,count(row.metricValues[trendColumns.metricIndexes[0]].value));
    }
    const limited = response.reports.some(r=>r.metadata?.subjectToThresholding || r.metadata?.dataLossFromOtherRow || r.metadata?.samplingMetadatas?.length);
    return {today,yesterday,timeZone:'Asia/Seoul',hostname:HOSTNAME,queriedAt:new Date(now()).toISOString(),cacheSeconds:60,
      limited:!!limited,current:summary(current,currentColumns),previous:summary(previous,previousColumns),
      daily:Array.from({length:30},(_,i)=>{const date=shiftDate(start,i);return {date,value:daily.get(date)||0};})};
    } catch (error) { throw error?.[DETAIL] ? error : failure('SCHEMA_UNEXPECTED'); }
    });
  }
  return async function getSummary() {
    if (cached && now()-cached.time<CACHE_MS && cached.value.today===koreanDate(now())) return measure('admin.traffic.cache', () => cached.value);
    if (pending) return measure('admin.traffic.shared', () => pending);
    if (now()<retryAt) return measure('admin.traffic.cooldown', () => { recordTrafficFailure({ category: 'COOLDOWN' }); throw Error('traffic-cooldown'); });
    pending=measure('admin.traffic.load', () => load()).then(value=>{cached={value,time:now()};return value;})
      .catch(error=>{recordTrafficFailure(error?.[DETAIL] || {category:'UPSTREAM_UNKNOWN'});retryAt=now()+10000;throw Error('traffic-summary-unavailable');}).finally(()=>{pending=null;});
    return pending;
  };
}
module.exports={createTrafficSummaryService,koreanDate,shiftDate};
