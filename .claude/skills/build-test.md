---
name: build-test
description: 빌드, 테스트, 린트를 실행할 때 사용. 변경사항 검증 전 반드시 참조.
---

# 빌드 & 테스트 명령어

## claude-dev-bot (Node.js)

# 의존성 설치
npm install

# 린트 (설정 있는 경우)
npm run lint

# 실행
node index.js

## blog-api (Kotlin/Spring Boot)

# 빌드
./gradlew build

# 테스트
./gradlew test

# 린트
./gradlew ktlintCheck

## blog-web (React/TypeScript)

# 타입 체크
npx tsc --noEmit

# 린트
npm run lint

# 테스트
npm test -- --watchAll=false

# 빌드
npm run build

## 검증 순서

1. 코드 작성/수정
2. 린트 실행 → 에러 수정
3. 타입 체크 (TS 프로젝트)
4. 단위 테스트 실행
5. 빌드 확인
6. 모두 통과하면 커밋

## 실패 시 처리
- 린트 에러: 자동 수정 후 재확인
- 테스트 실패: 반드시 원인 파악 후 수정 (테스트 삭제 금지)
- 빌드 실패: 에러 메시지 전체 분석 후 수정
