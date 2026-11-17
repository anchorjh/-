// 로컬 점검용: harness.html 을 http 로 서빙하고(IndexedDB 출처 필요) CDN 은 로컬 파일로 대체한다.
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const DIST = path.join(__dirname, '..', 'dist');
const JSZIP = path.join(__dirname, '..', 'node_modules', 'jszip', 'dist', 'jszip.min.js');
function serve() {
  return new Promise((res) => {
    const srv = http.createServer((req, rsp) => { rsp.setHeader('content-type', 'text/html; charset=utf-8'); rsp.end(fs.readFileSync(path.join(DIST, 'harness.html'))); });
    srv.listen(0, '127.0.0.1', () => res({ srv, url: `http://127.0.0.1:${srv.address().port}/` }));
  });
}
async function newPage(browser, opts) {
  const ctx = await browser.newContext(Object.assign({ locale: 'ko-KR', acceptDownloads: true, viewport: { width: 1360, height: 860 } }, opts || {}));
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.route('**/jszip.min.js', (r) => r.fulfill({ path: JSZIP, contentType: 'application/javascript' }));
  await page.route('**/fonts.googleapis.com/**', (r) => r.fulfill({ body: '', contentType: 'text/css' }));
  return { ctx, page, errors };
}
module.exports = { serve, newPage, chromium };
