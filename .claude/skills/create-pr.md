---
name: create-pr
description: PR을 생성할 때 사용. PR 제목과 본문을 프로젝트 표준 형식으로 작성한다.
---

# PR 생성 규칙

## PR 제목 형식

```
type(scope): 작업 내용 (#이슈번호)
```

좋은 예:
- `feat(auth): JWT 기반 로그인 API 추가 (#42)`
- `fix(post): 페이지네이션 마지막 페이지 중복 조회 수정 (#67)`
- `refactor(user): Service 레이어 책임 분리`

나쁜 예:
- `기능 추가` — type 없음
- `feat: 여러 가지 수정` — 구체적이지 않음
- `feat(auth): JWT 기반 로그인 API를 추가하였습니다` — 과도한 설명체

## PR 본문 템플릿

```markdown
## Summary
[무엇을 왜 구현했는지 2~3문장. "~를 추가함", "~를 수정함" 형태로.]

## Changes
- [기능 단위로 기술. 파일명 나열이 아님]
- [예: "로그인 시 JWT 토큰 발급 및 검증 로직 추가"]
- [예: "만료된 토큰 갱신 엔드포인트 구현"]

## Related Issue
Closes #이슈번호

## How to Test
- [ ] [실제 테스트 가능한 시나리오만]
- [ ] [예: "POST /auth/login으로 로그인 후 토큰 확인"]

## Review Points
[리뷰어가 특히 봐야 할 부분, 설계 결정 이유]
[예: "토큰 만료 시간을 30분으로 설정한 이유: ..."]
```

## 작성 원칙
- Summary는 수동형 금지 → "~를 추가함" 또는 "JWT 로그인 구현"
- Changes는 **파일명 나열이 아닌 기능 단위**로 기술
- How to Test는 실제 실행 가능한 시나리오만 (빈 체크리스트 금지)
- Review Points는 빠뜨리지 말 것 — 리뷰어의 시간을 아끼는 핵심
- 한 PR에 관련 없는 변경을 섞지 말 것
