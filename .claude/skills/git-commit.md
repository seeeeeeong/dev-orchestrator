---
name: git-commit
description: 커밋 메시지를 작성할 때 사용. staged 변경사항을 분석해서 프로젝트 컨벤션에 맞는 커밋 메시지를 생성한다.
---

# Git Commit Message 규칙

## 형식 — Conventional Commits

```
type(scope): 제목 (72자 이내, 한국어 가능)

본문 (선택: 복잡한 변경일 때만)
- 무엇을 변경했는지
- 왜 변경했는지 (어떻게는 쓰지 않음)

Footer (선택)
Closes #이슈번호
```

## Type 목록

| type | 언제 | 예시 |
|------|------|------|
| feat | 새 기능 추가 | feat(auth): JWT 로그인 API 추가 |
| fix | 버그 수정 | fix(post): 페이지네이션 마지막 페이지 중복 조회 수정 |
| refactor | 동작 변경 없는 코드 개선 | refactor(user): Service 레이어 메서드 분리 |
| test | 테스트 추가/수정 | test(auth): 토큰 만료 케이스 테스트 추가 |
| docs | 문서만 변경 | docs: API 엔드포인트 설명 보강 |
| chore | 빌드, 의존성, 설정 변경 | chore: Dockerfile 멀티스테이지 빌드 적용 |
| perf | 성능 개선 | perf(query): 게시글 목록 N+1 쿼리 해결 |
| style | 포매팅 (동작 무관) | style: ktlint 자동 포맷 적용 |

## Scope 규칙
- 변경의 가장 핵심적인 도메인/모듈명 사용
- 봇 프로젝트: commit, review, prompt, discord, cli
- blog-api: auth, post, user, comment, common
- blog-web: page, component, api, hook

## 나쁜 예시 (절대 금지)
- `update code` — 무엇을 업데이트?
- `fix bug` — 어떤 버그?
- `WIP`, `.`, `temp` — 의미 없는 메시지
- `feat: JWT 기반 로그인 API를 추가하였습니다` — 과도한 존칭/설명체

## 판단 기준
1. git diff --staged로 변경사항 파악
2. **가장 핵심적인 변경 하나**를 제목으로 (여러 관심사 → 분리 커밋 고려)
3. 제목만으로 "무엇이 바뀌었는지" 알 수 있어야 함
4. 이슈 번호가 있으면 Footer에 `Closes #번호`
