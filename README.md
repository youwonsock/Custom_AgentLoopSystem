# Custom Agent Loop System

> 대화형 코딩 CLI(`opencode`)를 자식 프로세스로 통제하여, 다수의 AI 에이전트가 자율적으로 목표를 달성하는 **동적 멀티 모델 지정형 멀티 세션 오케스트레이터**.
> Node.js/TypeScript 코어 엔진 + VS Code 확장 패널로 구성됩니다.

---

## 1. 요구사항

### 런타임
- **Node.js ≥ 18.0.0**
- 대상 코딩 CLI(기본 `opencode`)가 설치되어 PATH에 등록되어 있고, 인증/자격증명이 완료되어 있어야 함.
  - 모델 목록 탐색: `opencode models` 가 정상 응답해야 함.
- 운영체제: Windows / macOS / Linux (Windows는 `useConpty`, PATHEXT 기반 바이너리 해석 적용).

### 의존성 (Core 엔진)
- `fs-extra` — 원자적 파일 쓰기/디렉터리 보장.
- `node-pty` — 대화형 코딩 CLI를 가상 터미널(PTY) 자식 프로세스로 실행.
- 그 외 Node 표준 모듈(`child_process`, `fs`, `path`, `crypto`).

### 의존성 (VS Code 확장, `vscode-extension/`)
- `@types/vscode` ≥ 1.85.0
- VS Code ≥ 1.85.0
- 빌드 도구: `typescript`, `@vscode/vsce`

---

## 2. 아키텍처 개요

Core 엔진은 **명시적 함수 호출 체인(Explicit Function Call Chain)** 패러다임으로 동작합니다. `fs.watch` 같은 반응형 방식의 불안정성을 배제하고, Core가 제어권을 쥐고 순차적으로 다음 페이즈 함수를 호출합니다.

사용자의 원본 프로젝트 소스를 안전하게 보존하기 위해, 모든 상태/기억/에이전트 제어 파일은 **Core 자체 실행 디렉터리 내부의 `.goal/` 공간**에만 기록됩니다.

### 디렉터리 트리
```
<rootDir>/
├── loop_orchestrator.ts              # 전체 시스템 메인 엔진 코어 클래스
├── sessions_registry.json            # [글로벌] 전체 세션 및 CLI 가용 모델 목록 마스터 파일
└── .goal/
     └── sessions/
          └── [sessionId]/            # 발급된 고유 세션 ID 디렉터리
               ├── loop_state.json    # 세션 글로벌 상태, 에이전트 모델 매핑, 에러 큐
               ├── progress_notes.txt # 누적 시행착오 요약 노트 (롤링 서머리)
               ├── final_summary.json # 대성공 마감 리포트 (인간 감사용)
               ├── loop_history/      # 턴(Iteration)별 데이터 독립 보관 폴더
               │    └── loop_N_<phase>_<role>.json
               ├── 0_planner/         # [플래너 방] state, skills, in/out payload
               ├── 1_implementer/     # [구현가 방]
               ├── 2_tester/          # [테스터 방] output.json 에 테스트 산출물+verdict 저장
               ├── 3_qa_lead/         # [검증가 방]
               ├── 4_master/          # [마스터 방]
               └── 5_interrupter/     # [인터럽터 방]
```

각 에이전트 "방(room)"은 4개 파일로 구성됩니다:
- `state.json` — 동작 상태(idle/running/completed/failed), lastExitCode, lastRunAt.
- `skills.json` — 허용 도구(`allowedTools`), 절대적 행동 제약(`enforcedRules`), `systemPrompt`.
- `input.json` — 해당 페이즈에 주입된 HandoffPayload.
- `output.json` — 에이전트 산출물 (테스터는 verdict 포함).

---

## 3. 핵심 데이터 인터페이스

- **SessionRegistry** — 활성 세션 ID 배열, 외부 CLI에서 동적 획득한 가용 모델 배열(`availableModels`), 탐색 시각, 세션 메타 정보 목록, 수동 모델 오버라이드.
- **LoopState** — 세션 고유 ID, 실행 상태(`RUNNING`/`PAUSED`/`SUCCESS`/`FAILED`), 현재 페이즈, 루프 카운트, 에이전트별 모델 매핑, Lookback-5 에러 서명 큐, 에이전트별 동작 상태, 타임아웃/최대 반복 설정.
- **HandoffPayload** — 정제된 최종 목표, 대상 프로젝트 경로, progressNotes 문자열, 역방향 회귀 시 주입될 직전 실패 다이제스트.
- **AgentSkills** — 역할, 허용 도구 목록, `enforcedRules`(절대 어기면 안 되는 제약) 배열, systemPrompt.

---

## 4. 작동 방식

### 4.1 CLI 가용 모델 동적 검색 (`discoverCliModels`)
Core 기동/초기화 시 시스템 쉘에서 `opencode models`를 실행해 터미널 출력을 파싱합니다. `provider/model` 형식의 라인을 정규식으로 추출해 글로벌 마스터 파일(`sessions_registry.json`)에 저장합니다. VS Code 웹뷰는 이 목록을 드롭다운(공급자별 optgroup 그룹화)으로 실시간 인지합니다.

### 4.2 node-PTY 자식 프로세스 다중 모델 인젝션
각 에이전트 페이즈 함수 실행 시, 글로벌 상태에서 해당 에이전트용 지정 모델명을 조회합니다. `node-pty`로 자식 프로세스를 띄울 때 다음 인자를 조립해 주입합니다:

```
opencode run --format json --model <지정모델명> --dir <targetProjectPath> --dangerously-skip-permissions "<프롬프트>"
```

- PTY의 `cwd`는 유저의 실제 워크스페이스 경로(`targetProjectPath`).
- 환경변수로 세션 컨텍스트 전파: `AGENT_LOOP_SESSION_ID`, `AGENT_LOOP_AGENT_ROLE`, `AGENT_LOOP_PHASE`.
- 실시간 출력 스트림을 파싱하여 CLI가 대화형 컨피그를 요구하며 멈추는 패턴(`Apply changes? [y/n]`, `Continue? [y/n]`, `Proceed? [y/n]` 등 화이트리스트)을 포착 시 즉시 `y\n` 가상 입력을 주입하여 **무인 자율 구동**을 실현합니다.
- 페이즈 종료 sentinel 토큰 `[PHASE_DONE]` 감지로 에이전트 완료를 판정합니다.

### 4.3 Lookback-5 다중 진동 감지 가드레일 (`pushAndCheckOscillation`)
동일 에러나 순환형 복수 진동(A→B→A) 늪에 빠져 자원을 탕진하는 것을 방어합니다.
- 에러 히스토리를 최대 5개 큐로 관리.
- 입력된 에러 로그에서 정규식으로 파일명/에러 종류의 핵심 **지문(Signature)** 추출(경로는 `<PATH>`, 줄번호는 `<LN>` 등으로 정규화).
- 최근 5개 중 동일 지문이 **3회 이상** 발견되면 진동 확정 → 루프를 `PAUSED`로 잠그고 인터럽터 에이전트 자동 실행 → 유저에게 브리핑.
- 4개 이상일 땐 순환 패턴(최근 반쪽 = 이전 반쪽)도 진동으로 판정.

### 4.4 슬라이딩 윈도우 및 롤링 서머리 (`prepareHandoff`)
장기 루프 시 LLM 컨텍스트 폭증과 환각을 원천 차단합니다.
- 매 턴의 전체 raw 페이로드는 `loop_history/`에 영구 아카이빙(인간 디버깅 자산으로 격리).
- 검증 실패 후 구현가로 역방향 회귀하는 문맥에서만 **직전 회차의 실패 다이제스트 1개**를 주입해 프롬프트 크기를 O(1) 수준으로 다이어트.
- Core는 매 턴의 결론을 한 줄 요약 노트(`progress_notes.txt`)에 지속 누적해 에이전트들에게 최소한의 이정표로 공급.

### 4.5 누적 수정 정책 (비파괴)
유저 워크스페이스의 코드를 유실시키는 파괴적 명령(`git clean`, `git checkout --`, `git reset --hard`)은 **사용하지 않습니다**. 구현가는 이전 실패 코드를 안고 고쳐나가는 **누적 수정 방식**만 사용합니다(`enforcedRules`로 강제).

> 참고: 이전 버전의 쉘 테스트 명령(`npm test`) 실행 기반 검증과 포트 좀비 세정(`cleanPorts`) 기능은 제거되었습니다. 테스트는 이제 테스터 에이전트가 구현 내용을 기반으로 **AI가 직접 수행**합니다.

---

## 5. 파이프라인 설계 (중앙 제어 루프)

Core는 자율 순환 루프와 페이즈 전환 스위치를 결합한 **유한 상태 머신**으로 작동합니다. 루프 카운트가 `maxIterations`에 도달하면 `FAILED`로 종결합니다.

```
                    ┌──────────────────────────────────────────────┐
                    │  (루프 카운트 >= maxIterations → FAILED 종결)   │
                    └──────────────────────────────────────────────┘
 PLANNING ──► IMPLEMENTATION ──► TEST_GENERATION ──► VERIFICATION ──► MASTER_APPROVAL ──► SUCCESS
   (1회)         ▲                  (테스터 AI)        (QA 교차검증)      (최종 인수)        │
                 │                      │                  │                  │            │
                 │                      │           실패+진동미발생           반려           │ final_summary.json
                 └────── 역방향 회귀 ◄──┴──────────────────┘                  │            │  (1회 발행)
                                           실패+진동발생                       │            ▼
                                              → INTERRUPT(PAUSED) ◄────────────┘        루프 탈출
                                              인터럽터 브리핑 → 유저 개입
```

### 페이즈 명세

| # | 페이즈 | 담당 에이전트 | 동작 | 전진 조건 |
|---|--------|--------------|------|-----------|
| 1 | `PLANNING` | planner | 초기 1회만. 목표 분석 → 구현 계획 + 에이전트별 매핑 모델 확정. | 계획 산출 시 `planningComplete=true` → IMPLEMENTATION |
| 2 | `IMPLEMENTATION` | implementer | 지정 모델 플래그·세션 ID·스킬 명세 래핑해 PTY 가동. 소스코드 누적 수정. | 코드 수정 완료(`[PHASE_DONE]`) → TEST_GENERATION |
| 3 | `TEST_GENERATION` | tester | **구현가가 변경한 파일을 읽고**, 그 구현에 맞는 테스트를 직접 설계·작성·실행(bash 도구). `VERDICT: PASS/FAIL` 출력. 산출물을 `2_tester/output.json`에 저장(verdict 포함). | 테스트 수행 완료 → VERIFICATION |
| 4 | `VERIFICATION` | qa_lead | 테스터의 verdict와 출력을 교차 검증(치팅/목킹/빈 assertion/스킵 탐지) + 목표 충족 여부 확인. `APPROVED`/`REJECTED`. | APPROVED → MASTER_APPROVAL / REJECTED → 진동 감지 후 IMPLEMENTATION 역회귀 또는 INTERRUPT |
| 5 | `MASTER_APPROVAL` | master | 최종 인수 테스트. | 승인 → `final_summary.json` 1회 발행 + `SUCCESS` 종결 / 반려 → IMPLEMENTATION 회귀 |
| - | `INTERRUPT` | interrupter | 진동 감지 시 자동 진입. 에러 히스토리+progress notes 분석 → 유저에게 원인과 해결책 브리핑. | 유저 개입 후 `resume` |

### 역방향 회귀 핸드오프
VERIFICATION 실패 시:
1. `extractFailureDigest()`로 QA 출력 + 테스터 출력에서 실패 다이제스트 추출.
2. Lookback-5 진동 감지 가동.
   - 진동 미발생 → 직전 실패 다이제스트만 들고 `IMPLEMENTATION`으로 역방향 회귀.
   - 진동 발생 → `INTERRUPT` 진입, `PAUSED` 잠금.

### 에이전트별 스킬 요약
| 역할 | 허용 도구 | 핵심 제약 |
|------|-----------|----------|
| planner | read, glob, grep, bash, webfetch | 소스 수정 금지. 실행 가능한 계획만 산출. |
| implementer | read, write, edit, glob, grep, bash | 파괴적 git 금지. 누적 수정만. target 경로 내 파일만. |
| tester | read, write, edit, glob, grep, bash | **구현 내용 기반** 테스트 설계·실행. 프로덕션 코드 수정 금지(테스트 파일만). `VERDICT: PASS/FAIL` 필수. |
| qa_lead | read, glob, grep, bash | 파일 수정 금지. 테스트 치팅 탐지. `APPROVED`/`REJECTED` 출력. |
| master | read, glob, grep, bash | 파일 수정 금지. 최종 인수 테스트. `APPROVED`/`REJECTED`. |
| interrupter | read, glob, grep | 파일 수정 금지. 진동 분석 + 유저 브리핑. |

---

## 6. CLI 사용법

```bash
# 빌드
npm install
npm run build      # tsc → dist/loop_orchestrator.js

# 초기화 (현재 디렉터리에 .goal/ + sessions_registry.json 생성)
node dist/loop_orchestrator.js init

# 가용 모델 탐색
node dist/loop_orchestrator.js models [--binary opencode] [--root <path>]

# 새 세션 실행
node dist/loop_orchestrator.js run \
  --goal "Add JWT auth to the Express app" \
  --target ./my-project \
  --binary opencode \
  --max-iterations 20 \
  --phase-timeout 600000 \
  --idle-timeout 90000 \
  [--planner-model <m>] [--implementer-model <m>] \
  [--tester-model <m>] [--qa-model <m>] \
  [--master-model <m>] [--interrupter-model <m>]

# 일시정지된 세션 재개
node dist/loop_orchestrator.js resume --session <sessionId> [--root <path>]
```

모델 미지정 시 발견된 가용 모델 중 첫 번째를 자동 할당하며, 발견 실패 시 폴백 모델(`anthropic/claude-sonnet-4-5`)을 사용합니다.

---

## 7. VS Code 확장 (Kilo Code 스타일 UI)

`vscode-extension/` 에 별도 패키지로 제공되는 확장이 Core 엔진을 GUI로 제어합니다.

### 빌드 및 설치
```bash
cd vscode-extension
npm install
npm run compile
npx vsce package            # → agent-loop-vscode-<ver>.vsix
code --install-extension agent-loop-vscode-<ver>.vsix --force
```
개발/재설치 시 이전 버전 vsix 및 확장 디렉터리는 삭제 후 새 버전만 유지합니다.

### 기능
- **액티비티바 "Agent Loop" 아이콘** → Sessions 트리 뷰 + 뷰 헤더 버튼(New Session / Show Panel / Discover Models / Refresh).
- **웹뷰 컨트롤 패널**: Kilo Code 스타일 하단 composer(goal textarea + target 경로 + Start Session), 상단 툴바(세션 선택/Resume/Stop/Models/Notes), 메인 그리드(Status / Model Mapping / Progress Notes / Loop History / Live Log Stream).
- **모델 드롭다운**: 공급자별 `<optgroup>` 그룹화, 역할별(Planner/Implementer/Tester/QA Lead/Master/Interrupter) 모델 지정.
- **드롭다운 자동 닫힘 방지**: 폴링 기반 재렌더 시 상호작용 가드 + 상태 시그니처 스킵으로 열려 있는 `<select>`가 파괴되지 않음.
- **Compose 모드**: "New Session" 클릭 시 기존 세션 유무와 무관하게 composer 뷰 고정(ESC/Cancel로 취소).
- **실시간 로그 스트리밍**: Core 자식 프로세스 stdout/stderr를 가로채 패널에 출력.
- **설정(`agentLoop.*`)**: `cliBinary`, `rootDir`, `nodeBinary`, `orchestratorScript`, `maxIterations`, `phaseTimeoutMs`, `idleTimeoutMs`, `pollIntervalMs`.

> 참고: 테스트 명령(`testCommand`)과 포트 세정(`portsToClean`) 설정은 AI 주도 테스트 전환에 따라 제거되었습니다.

---

## 8. 안정성 설계

- **원자적 쓰기(Atomic Write)**: 모든 JSON 상태 파일은 `.tmp.<pid>.<ts>.<rand>` 임시 파일 작성 후 rename. Windows EPERM/EBUSY/EACCES 시 지수 백오프 재시도(`renameWithRetry`). 손상 감지 시 `.corrupt.<ts>` 백업 후 재생성.
- **프로세스 좀비 방지**: PTY 종료 시 자식 프로세스 트리까지 정리(Windows `taskkill /T /F`, POSIX `pkill -TERM -P`).
- **타임아웃 이중 가드**: 페이즈 타임아웃(`phaseTimeoutMs`) + 유휴 타임아웃(`idleTimeoutMs`).
- **신호 핸들러**: SIGINT/SIGTERM 수신 시 현재 PTY 정리 후 상태 저장 후 종료.
- **세션 격리**: 각 세션은 독립 디렉터리 + 독립 룸 파일 세트로 완전 격리, 다중 세션 동시 구동 지원.
