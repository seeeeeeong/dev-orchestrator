---
name: core-conventions
description: claude-dev-bot(Node.js) 자체 코드 수정 시 참조하는 컨벤션.
---

# claude-dev-bot 코딩 컨벤션

## 모듈 시스템
- CommonJS (`require`/`module.exports`)

## CLI/프로세스 실행 규칙
- git 명령어는 `runCmd`/`runSpawn`/`gitCommit` 함수를 통해서만 실행
- Claude CLI 호출은 반드시 `runClaude` 함수 사용
- `spawn` 사용 시 `shell: true` 금지 (명령어 인젝션 위험)

## Discord 규칙
- 메시지 2000자 제한 준수 (`sendChunks` 활용)
- 에러 메시지는 `.slice(0, 500)`으로 잘라서 전송

## 보안
- `.env` 토큰/키 하드코딩 절대 금지
- 외부 입력(Discord 메시지)을 그대로 CLI 인자로 전달 금지
- `eval()`, `new Function()` 등 동적 코드 실행 금지

## 코드 스타일
- 함수/메서드는 단일 책임 원칙
- 매직 넘버/문자열 → 상수로 추출 (예: `MAX_REVIEW_RETRIES`)
- 새 유틸 만들기 전에 기존 함수로 해결 가능한지 먼저 확인
