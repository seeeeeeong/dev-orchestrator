---
name: create-pr
description: PR을 생성할 때 사용. PR 제목과 본문을 프로젝트 표준 형식으로 작성한다.
---

# PR 생성 규칙

## PR 제목 형식
[type]: [작업 내용] (#이슈번호)

예시:
feat: JWT 기반 로그인 API 추가 (#42)
fix: 페이지네이션 마지막 페이지 중복 조회 수정 (#67)

## PR 본문 템플릿

## Summary
[무엇을 왜 구현했는지 2~3문장]

## Changes
- [주요 변경 bullet — 파일명보다 기능 단위로]

## Related Issue
Closes #[이슈번호]

## How to Test
- [ ] [테스트 시나리오]

## Review Points
[설계 결정, 주의깊게 봐야 할 부분]

## 작성 원칙
- Summary는 수동형 금지 → "~를 추가함" or "JWT 로그인 구현"
- Changes는 파일명보다 기능 단위로 기술
- Review Points는 빠뜨리지 말 것
- 체크리스트는 실제 테스트 가능한 것만
