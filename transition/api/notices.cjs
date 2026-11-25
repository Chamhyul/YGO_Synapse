'use strict';
const noticeSource = 'https://storage.googleapis.com/ygo-synapse.firebasestorage.app/public/notices.json';
async function readPublicNotices(fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetchImpl(new URL(noticeSource), { headers: { Accept: 'application/json' }, cache: 'no-cache', redirect: 'error', signal: controller.signal });
    if (!response.ok) throw Error('NOTICE_UNAVAILABLE');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) { controller.abort(); throw Error('NOTICE_UNAVAILABLE'); }
      chunks.push(chunk);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Array.isArray(value.notices) || value.notices.length > 1000 || value.notices.some(n => !n || typeof n.id !== 'string' || n.id.length > 128 || typeof n.title !== 'string' || typeof n.content !== 'string')) throw Error('NOTICE_UNAVAILABLE');
    return { success: true, notices: value.notices.map(n => ({ id: n.id, title: n.title, content: n.content, isPinned: Number(n.isPinned) || 0 })) };
  } catch (_) { throw Object.assign(Error('NOTICE_UNAVAILABLE'), { status: 503 }); }
  finally { clearTimeout(timer); }
}
module.exports = { readPublicNotices, noticeSource };
