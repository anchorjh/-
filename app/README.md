# 소설 작업실 — 1단계(기반) + 2단계(AI) + 3단계(편집자 모드·관리 화면)

1단계: 쓰고, 세고, 보존한다. 2단계: AI가 집필·개고·변환·심사한다(아티팩트의 `sample` 기능 사용).

- `src/core.js` 글자 수·원고지 환산·단락 ID 보존·버전 비교·찾기/바꾸기·정리·문체 통계·백업 검증 (순수 로직)
- `src/docx.js` DOCX 만들기/읽기, HWPX 읽기(실험적)
- `src/storage.js` 저장 계층(IndexedDB / 메모리). 나중에 서버 저장소로 바꿀 때 이 파일만 교체
- `src/prompts.js` 역할별 프롬프트(버전 기록)
- `src/ai.js` AI 작업 엔진: 호출 래퍼, 단계(step) 기반 작업 실행기, 재개, 잠금·분량·잘림 검증
- `src/ai-ui.js` 새 작품 마법사, AI 작업실, 진행 패널, 보고서
- `src/app.js`, `src/style.css` 화면
- `build.js` → `dist/novel-studio.html`(아티팩트용 조각), `dist/harness.html`(로컬 점검용)

```
npm i            # 테스트용 jszip
npm test         # AI 없이 도는 단위 테스트
node build.js && node test/e2e.js   # 실제 Chromium 점검 (playwright 필요)
```

## 2단계 테스트에 대해
`test/mock-sample.js` 는 실제 Claude 대신 쓰는 가짜 `sample()` 이다. 단계 연결·중지/재개·저장·검증·화면 표시를 점검하지만
**문학적 품질은 검증하지 못한다.** 실제 품질은 게시된 아티팩트에서 직접 써 보고 판단해야 한다.
`node test/e2e-ai.js` 는 가짜 Claude 로 마법사·개고·원클릭·변환·심사를 크롬에서 끝까지 돌린다.

## 3단계
- 개고 제안(편집자 모드): 모델은 `old/new/why` 만 내고, 코드(`core.verifyEdits`)가 원문 1회 출현·잠금·늘림 금지 등을 검증, 작가가 한 줄씩 수락·거절
- AI 교열 단독, 장면 AI 작업 12종, 장르 전환, 고증 점검, 인물·설정·연속성, 공모전 관리, 문체 프로필
- 테스트: `node test/e2e-ai3.js`(제안·교열·장면·프로필), `node test/e2e-ai4.js`(전환·고증·설정·공모전)
