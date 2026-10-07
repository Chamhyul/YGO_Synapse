const test = require('node:test');
const assert = require('node:assert/strict');
const { addFooterLicenseLink } = require('./stage_private_hosting');

for (const [name, linkClass, separatorClass] of [
  ['기존', 'footer-link-item', 'footer-link-separator'],
  ['신규', 'app-footer__link', 'app-footer__link-separator'],
]) {
  const privacy = `<a href="privacy.html" class="${linkClass}" onclick="openPrivacyModal(event)">개인정보 처리방침</a>`;
  const license = `<span class="${separatorClass}">•</span><a href="licenses.html" class="${linkClass}">라이선스 및 출처</a>`;

  test(`${name} 푸터의 명칭에 맞춰 라이선스 링크를 추가하며 재실행해도 한 번만 삽입한다`, () => {
    const before = `<main><a href="privacy.html" class="ui-link">개인정보 처리방침</a></main>\n<footer id="main-footer">\n  ${privacy}\n</footer>`;
    const expected = before.replace(privacy, privacy + license);
    assert.equal(addFooterLicenseLink(before), expected);
    assert.equal(addFooterLicenseLink(expected), expected);
  });

  test(`${name} 푸터에 라이선스 링크가 이미 있으면 문서를 그대로 보존한다`, () => {
    const before = `<footer id="main-footer">\n  ${privacy}\n  ${license}\n</footer>`;
    assert.equal(addFooterLicenseLink(before), before);
  });
}

test('대상 푸터 또는 지원하는 개인정보 링크가 없으면 다른 영역을 변경하지 않는다', () => {
  for (const html of [
    '<main><a href="privacy.html" class="footer-link-item">개인정보 처리방침</a></main>',
    '<main><a href="privacy.html" class="app-footer__link">개인정보 처리방침</a></main><footer>문의</footer>',
    '<footer><a href="privacy.html" class="other-link">개인정보 처리방침</a></footer>',
  ]) assert.equal(addFooterLicenseLink(html), html);
});
