# Dev Orchestrator Agent Guide

## 프로젝트 개요
Discord 봇으로 Claude Code CLI + GPT-5.4 리뷰를 연동하여
자동 코딩 → 리뷰 → PR/이슈 생성까지 수행하는 개발 자동화 봇.

## 기술 스택
- Node.js (CommonJS)
- Discord.js 14
- Claude Code CLI (`claude -p`)
- OpenAI SDK (GPT-5.4 리뷰)
- gh CLI (GitHub PR/이슈)

## 프로젝트 맵
- `index.js` — 봇 메인 (모든 로직)
- `repos/` — 클론된 프로젝트들 (gitignore)
- `.env` — 토큰, API 키

## 절대 규칙
- .env 파일의 토큰/키 절대 하드코딩 금지
- spawn 사용 시 shell: true 금지 (명령어 인젝션 방지)
- Discord 메시지 길이 2000자 제한 준수 (sendChunks 활용)
- git 명령어는 runCmd/runSpawn/gitCommit 함수를 통해서만 실행
- Claude CLI 호출은 반드시 runClaude 함수 사용

## 핵심 흐름
1. Discord 명령 수신 → parseCommand / parseNaturalLanguage
2. ensureRepo로 프로젝트 준비
3. buildWorkPrompt로 구조화된 프롬프트 생성
4. runClaude로 코드 작업 실행
5. generateCommitMsg로 커밋 메시지 생성
6. reviewCode → GPT-5.4 리뷰 (최대 5회 루프)
7. autoFix → 리뷰 실패 시 자동 수정
8. buildPRBody → PR 본문 생성 및 PR 생성
9. generateIssueBody → 이슈 생성

## 커밋 & PR 스킬 참조
- 커밋: `.claude/skills/git-commit.md`
- PR: `.claude/skills/create-pr.md`
- 빌드/테스트: `.claude/skills/build-test.md`
- 컨벤션: `.claude/skills/core-conventions.md`

## 주의사항
- working 플래그로 동시 작업 방지 중 (단일 작업만 가능)
- 프롬프트 빌더 함수 수정 시 출력 형식 변경에 주의
- Claude CLI는 cwd의 CLAUDE.md를 자동 로드함
