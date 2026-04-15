---
name: core-conventions
description: 코딩 컨벤션 상세 참조. 코드 작성/리뷰 시 로드.
---

# 코딩 컨벤션

## 공통
- 함수/메서드는 단일 책임 원칙
- 매직 넘버/문자열 → 상수로 추출
- 주석: "왜"를 설명, "무엇"은 코드가 설명
- TODO 주석에는 이슈 번호 포함: // TODO(#42): ...

## Node.js (봇 프로젝트)
- CommonJS (require/module.exports)
- spawn 사용 시 shell: true 금지
- Discord 메시지 2000자 제한 준수 (sendChunks 활용)
- git 명령어는 runCmd/runSpawn/gitCommit 함수를 통해서만 실행
- Claude CLI 호출은 반드시 runClaude 함수 사용
- .env 토큰/키 하드코딩 절대 금지

## Kotlin/Spring Boot
- ApiResponse<T> 래퍼 사용
- 예외는 GlobalExceptionHandler로 통일
- DB 스키마 변경 시 Flyway 마이그레이션 함께 생성
- DTO는 data class + @JsonNaming(SnakeCaseStrategy::class)

## TypeScript/React
- any 타입 사용 절대 금지
- API 호출은 반드시 src/api/ 함수를 통해서
- 컴포넌트 파일 하나당 하나의 컴포넌트
- CSS-in-JS 금지 → TailwindCSS만 사용
- console.log 커밋 금지
- Props 타입은 interface 사용
- 이벤트 핸들러: handle 접두사
- 커스텀 훅: use 접두사 필수
