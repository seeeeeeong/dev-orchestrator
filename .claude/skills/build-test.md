---
name: build-test
description: 빌드, 테스트, 린트를 실행할 때 사용. 변경사항 검증 전 반드시 참조.
---

# 빌드 & 테스트 명령어

## claude-dev-bot (Node.js)

```bash
npm install        # 의존성 설치
npm run lint       # 린트 (설정 있는 경우)
node index.js      # 실행 (프로세스가 뜨면 정상)
```

## blog-api (Kotlin/Spring Boot)

```bash
./gradlew build           # 빌드 (테스트 포함)
./gradlew test            # 테스트만
./gradlew ktlintCheck     # 린트
./gradlew ktlintFormat    # 린트 자동 수정
```

## blog-web (React/TypeScript)

```bash
npx tsc --noEmit                # 타입 체크
npm run lint                    # 린트
npm run lint -- --fix           # 린트 자동 수정
npm test -- --watchAll=false    # 테스트
npm run build                   # 빌드
```

## 검증 절차 (이 순서대로 실행)

1. **린트** → 에러 있으면 자동 수정 후 재확인
2. **타입 체크** (TS 프로젝트만)
3. **테스트** → 실패 시 반드시 원인 파악 후 수정
4. **빌드** → 에러 메시지 전체 분석 후 수정
5. **모두 통과하면 커밋**

## 실패 시 처리 규칙

| 상황 | 올바른 대응 | 절대 금지 |
|------|------------|----------|
| 린트 에러 | 자동 수정(`--fix`) 후 재확인 | 린트 규칙 비활성화 |
| 테스트 실패 | 원인 파악 후 코드 수정 | 테스트 삭제 또는 skip |
| 타입 에러 | 타입 정의 수정 | `any` 캐스팅 |
| 빌드 실패 | 에러 로그 분석 후 수정 | `--no-verify` 커밋 |

## 기존 테스트가 깨졌을 때

- 내가 변경한 코드 때문에 깨진 건지 먼저 확인
- 기존 테스트의 기대값이 맞는지 확인 (테스트가 잘못되었을 수 있음)
- 의도한 동작 변경이면 테스트도 함께 업데이트
- **절대 하지 말 것**: 이해 없이 테스트 기대값만 바꾸기
