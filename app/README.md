# 소설 작업실 — 1단계 (AI 없는 기반)

쓰고, 세고, 보존한다. AI 기능은 2단계부터 붙는다.

- `src/core.js` 글자 수·원고지 환산·단락 ID 보존·버전 비교·찾기/바꾸기·정리·문체 통계·백업 검증 (순수 로직)
- `src/docx.js` DOCX 만들기/읽기, HWPX 읽기(실험적)
- `src/storage.js` 저장 계층(IndexedDB / 메모리). 나중에 서버 저장소로 바꿀 때 이 파일만 교체
- `src/app.js`, `src/style.css` 화면
- `build.js` → `dist/novel-studio.html`(아티팩트용 조각), `dist/harness.html`(로컬 점검용)

```
npm i            # 테스트용 jszip
npm test         # AI 없이 도는 단위 테스트
node build.js && node test/e2e.js   # 실제 Chromium 점검 (playwright 필요)
```
