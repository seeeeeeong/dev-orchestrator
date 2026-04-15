---
name: git-commit
description: 커밋 메시지를 작성할 때 사용. staged 변경사항을 분석해서 프로젝트 컨벤션에 맞는 커밋 메시지를 생성한다.
---

# Git Commit Message 규칙

## 형식 — Conventional Commits

type(scope): 제목 (72자 이내, 한국어 가능)

## Type 목록

| type | 언제 |
|------|------|
| feat | 새 기능 추가 |
| fix | 버그 수정 |
| refactor | 동작 변경 없는 코드 개선 |
| test | 테스트 추가/수정 |
| docs | 문서만 변경 |
| chore | 빌드, 의존성, 설정 변경 |
| perf | 성능 개선 |
| style | 포매팅 (동작 무관) |

## Scope 예시
봇: commit, review, prompt, discord, cli

## 좋은 예시
feat(auth): JWT 기반 로그인 API 추가
fix(post): 페이지네이션 마지막 페이지 중복 조회 수정

## 나쁜 예시 (절대 금지)
update code, fix bug, WIP, .

## 작성 절차
1. git diff --staged로 변경사항 파악
2. 가장 핵심적인 변경 하나를 제목으로
3. 여러 변경이 있으면 분리 커밋 고려
4. 이슈 번호 알면 Footer에 반드시 추가
