const cheerio = require('cheerio');
const ALLOWED_NOTICE_TAGS = new Set([
  "a", "b", "blockquote", "br", "code", "del", "div", "em", "h1", "h2", "h3",
  "h4", "h5", "h6", "hr", "i", "li", "ol", "p", "pre", "s", "span", "strong", "u", "ul",
]);
const DROP_WITH_CONTENT_TAGS = new Set([
  "base", "embed", "frame", "iframe", "link", "meta", "object", "script", "style", "svg", "template",
]);

function isSafeNoticeHref(href) {
  try {
    const url = new URL(href, "https://ygo-synapse.web.app");
    return ["http:", "https:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}

/** 허용된 서식만 남기고 공지 HTML에서 실행 가능한 요소와 속성을 제거합니다. */
function sanitizeNoticeHtml(content) {
  const $ = cheerio.load(String(content || ""), null, false);

  $("*").toArray().reverse().forEach(node => {
    const tag = node.tagName && node.tagName.toLowerCase();
    if (!tag) return;

    if (!ALLOWED_NOTICE_TAGS.has(tag)) {
      if (DROP_WITH_CONTENT_TAGS.has(tag)) $(node).remove();
      else $(node).replaceWith($(node).contents());
      return;
    }

    const attrs = node.attribs || {};
    const href = attrs.href;
    const title = attrs.title;
    const target = attrs.target;
    Object.keys(attrs).forEach(name => $(node).removeAttr(name));

    if (tag === "a") {
      if (href && isSafeNoticeHref(href)) $(node).attr("href", href);
      if (title) $(node).attr("title", title);
      if (target === "_blank") {
        $(node).attr("target", "_blank");
        $(node).attr("rel", "noopener noreferrer");
      }
    }
  });

  return $.root().html() || "";
}

function sanitizeNoticeTitle(title) {
  const $ = cheerio.load(String(title || ""), null, false);
  return $.text().trim();
}


module.exports = { sanitizeNoticeHtml, sanitizeNoticeTitle };
