// 소설 작업실 빌드: src/* 를 하나의 HTML 조각(아티팩트용)으로 합친다.
const fs = require('fs'), path = require('path');
const rd = (f) => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8');
const scripts = ['core.js', 'docx.js', 'storage.js', 'prompts.js', 'ai.js', 'ai-ui.js', 'app.js'].map((f) => { const s = rd(f); if (/<\/script/i.test(s)) throw new Error(f + '에 </script 가 있습니다'); return `<script>\n/* ${f} */\n${s}\n</script>`; });
const fragment = `<title>소설 작업실</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700&family=Noto+Serif+KR:wght@400;600&display=swap">
<style>
${rd('style.css')}
</style>
<div id="app"><div style="padding:24px;color:var(--muted)">불러오는 중…</div></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
${scripts.join('\n')}
`;
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', 'novel-studio.html'), fragment);
// 로컬 점검용: 게시 시 붙는 뼈대와 같은 모양으로 감싼다.
fs.writeFileSync(path.join(__dirname, 'dist', 'harness.html'), `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;padding-block:env(safe-area-inset-top,0px) env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui}[hidden]{display:none!important}</style></head><body>${fragment}</body></html>`);
console.log('built', fragment.length, 'bytes');
