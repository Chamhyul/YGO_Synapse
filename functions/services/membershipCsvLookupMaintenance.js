'use strict';
// 호출자의 접근은 Cloud IAM private invoker로 제한한다. 운영 원본·활성 포인터는
// 바꾸지 않으며, 명시한 활성 revision에 대한 재생성 가능한 보조 자료만 준비한다.
function createLookupMaintenance({ select }) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const body = req.body;
    if (!body || Array.isArray(body) || typeof body.dryRun !== 'boolean'
        || Object.keys(body).some(k => !['dryRun', 'revision', 'fingerprint'].includes(k))
        || !body.dryRun && (!/^[a-f0-9]{32}$/.test(body.revision || '') || !/^[a-f0-9]{64}$/.test(body.fingerprint || ''))) {
      return res.status(400).json({ success: false, code: 'CSV_LOOKUP_INVALID_REQUEST' });
    }
    try {
      const runtime = select();
      if (runtime?.config.mode !== 'production' || !runtime.storage?.membershipCsv?.prepareActiveLookup) throw Error();
      const result = await runtime.storage.membershipCsv.prepareActiveLookup(body);
      return res.json({ success: true, ...result });
    } catch (error) {
      return error?.code === 'MEMBERSHIP_CSV_CONFLICT'
        ? res.status(409).json({ success: false, code: 'CSV_LOOKUP_CONFLICT' })
        : res.status(503).json({ success: false, code: 'CSV_LOOKUP_UNAVAILABLE' });
    }
  };
}
module.exports = { createLookupMaintenance };
