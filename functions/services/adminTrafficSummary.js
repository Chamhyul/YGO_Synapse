/** GA4 집계값만 제공한다. 사용자·URL·계정 차원은 응답/로그에 전달하지 않는다. */
const CACHE_MS = 60000;
const METRICS = ['activeUsers', 'sessions', 'screenPageViews'];
const HOSTNAME = 'ygo-synapse.web.app';
function koreanDate(time) {
  return new Date(time + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function shiftDate(date, days) {
  return new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}
function count(value) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw Error('invalid-count');
  return Number(value);
}
function checkReport(report, metrics, dimensions) {
  if (!report || report.metadata?.timeZone !== 'Asia/Seoul'
      || JSON.stringify((report.metricHeaders || []).map(h => h.name)) !== JSON.stringify(metrics)
      || JSON.stringify((report.dimensionHeaders || []).map(h => h.name)) !== JSON.stringify(dimensions)
      || (report.rowCount || 0) !== (report.rows || []).length) throw Error('invalid-report');
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
    const response = await run([request(today,today,METRICS),request(yesterday,yesterday,METRICS),request(start,today,['activeUsers'],['date'])]);
    if (response.reports?.length !== 3) throw Error('missing-reports');
    const [current, previous, trend] = response.reports;
    checkReport(current,METRICS,[]);checkReport(previous,METRICS,[]);checkReport(trend,['activeUsers'],['date']);
    const summary = report => {
      if ((report.rows || []).length > 1) throw Error('invalid-summary');
      if (!(report.rows || []).length) return Object.fromEntries(METRICS.map(m=>[m,0]));
      const values = report.rows[0].metricValues;
      if (values?.length !== 3) throw Error('invalid-metrics');
      return Object.fromEntries(METRICS.map((m,i)=>[m,count(values[i].value)]));
    };
    const daily = new Map();
    for (const row of trend.rows || []) {
      const raw = row.dimensionValues?.[0]?.value;
      if (!/^\d{8}$/.test(raw) || row.dimensionValues.length !== 1 || row.metricValues?.length !== 1) throw Error('invalid-date');
      const date = `${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}`;
      if (date < start || date > today || shiftDate(date,0) !== date || daily.has(date)) throw Error('invalid-date');
      daily.set(date,count(row.metricValues[0].value));
    }
    const limited = response.reports.some(r=>r.metadata?.subjectToThresholding || r.metadata?.dataLossFromOtherRow || r.metadata?.samplingMetadatas?.length);
    return {today,yesterday,timeZone:'Asia/Seoul',hostname:HOSTNAME,queriedAt:new Date(now()).toISOString(),cacheSeconds:60,
      limited:!!limited,current:summary(current),previous:summary(previous),
      daily:Array.from({length:30},(_,i)=>{const date=shiftDate(start,i);return {date,value:daily.get(date)||0};})};
  }
  return async function getSummary() {
    if (cached && now()-cached.time<CACHE_MS && cached.value.today===koreanDate(now())) return cached.value;
    if (pending) return pending;
    if (now()<retryAt) throw Error('traffic-cooldown');
    pending=load().then(value=>{cached={value,time:now()};return value;})
      .catch(()=>{retryAt=now()+10000;throw Error('traffic-summary-unavailable');}).finally(()=>{pending=null;});
    return pending;
  };
}
module.exports={createTrafficSummaryService,koreanDate,shiftDate};
