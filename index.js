require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');

// ─── 설정 ───
const WORKSPACE = path.join(__dirname, 'repos');
const MAX_REVIEW_RETRIES = 3;
const OPENAI_MODEL = 'gpt-4.1-mini';

// ─── OpenAI 텍스트 생성 공통 헬퍼 ───
async function runOpenAIText(prompt) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await openai.responses.create({
    model: OPENAI_MODEL,
    input: prompt,
  });
  return (response.output_text || '').trim();
}
const PROJECTS = {
  'blog-api': {
    repo: 'https://github.com/seeeeeeong/blog-api.git',
    branch: 'main',
  },
  'blog-ai': {
    repo: 'https://github.com/seeeeeeong/blog-ai.git',
    branch: 'main',
  },
  'blog-web': {
    repo: 'https://github.com/seeeeeeong/blog-web.git',
    branch: 'main',
  },
  'claude-dev-bot': {
    repo: 'https://github.com/seeeeeeong/claude-dev-bot.git',
    branch: 'main',
  },
};

if (!fs.existsSync(WORKSPACE)) fs.mkdirSync(WORKSPACE);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// ─── working 플래그 (파일 기반 — 봇 재시작 시에도 유지) ───
const LOCK_FILE = path.join(__dirname, '.working.lock');

function isWorking() {
  if (!fs.existsSync(LOCK_FILE)) return false;
  // 1시간 이상 된 lock은 stale로 판단 (이전 크래시 잔해)
  const stat = fs.statSync(LOCK_FILE);
  if (Date.now() - stat.mtimeMs > 60 * 60 * 1000) {
    fs.unlinkSync(LOCK_FILE);
    return false;
  }
  return true;
}
function setWorking(v) {
  if (v) fs.writeFileSync(LOCK_FILE, `${Date.now()}`);
  else if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
}

// ─── 유틸 ───
function runCmd(cmd, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', ['-c', cmd], { cwd, env: process.env });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (code) =>
      code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || stdout))
    );
  });
}

function runSpawn(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, env: process.env });
    let stdout = '', stderr = '';
    let settled = false;
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', (err) => {
      if (!settled) { settled = true; reject(err); }
    });
    proc.on('close', (code) => {
      if (!settled) {
        settled = true;
        code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || stdout));
      }
    });
  });
}

function gitCommit(message, cwd) {
  return new Promise((resolve, reject) => {
    const raw = typeof message === 'string' ? message : '';
    const safeMsg = raw.trim() || 'feat: 자동 작업';
    const proc = spawn('git', ['commit', '-m', safeMsg], { cwd, env: process.env });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (code) =>
      code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || stdout))
    );
  });
}

// ─── Claude CLI (JSON 출력 + 세션 연속성) ───
function runClaude(prompt, cwd, { sessionId = null } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--dangerously-skip-permissions',
      '--model', 'claude-opus-4-6',
    ];
    if (sessionId) args.push('--resume', sessionId);

    const proc = spawn('claude', args, {
      cwd,
      env: process.env,
      timeout: 600000,
    });

    let stdout = '';
    proc.stdout.on('data', (d) => (stdout += d));
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (code, signal) => {
      if (signal) {
        reject(new Error(`Claude CLI killed by signal ${signal}`));
        return;
      }
      const cleaned = cleanOutput(stdout.trim());
      try {
        const json = JSON.parse(cleaned);
        if (json.is_error) {
          reject(new Error(json.result || 'Claude error'));
        } else {
          resolve({
            sessionId: json.session_id || null,
            text: (json.result || '').trim(),
            cost: json.cost_usd || null,
          });
        }
      } catch {
        // JSON 파싱 실패 시 plain text 폴백
        if (code !== 0 && code !== null) {
          const errMsg = stderr.trim().slice(0, 500);
          reject(new Error(`Claude CLI exited with code ${code}${cleaned ? `\n${cleaned.slice(0, 500)}` : ''}${errMsg ? `\nstderr: ${errMsg}` : ''}`));
        } else {
          resolve({ sessionId: null, text: cleaned, cost: null });
        }
      }
    });
    proc.on('error', reject);
  });
}

// Warning 메시지 제거
function cleanOutput(text) {
  return text
    .replace(/Warning: no stdin data received.*\n?/g, '')
    .replace(/If piping from a slow command.*\n?/g, '')
    .trim();
}

// ─── 프로젝트 설정 확인 ───
function checkProjectSetup(projectPath, projectName) {
  const claudeMdPath = path.join(projectPath, 'CLAUDE.md');
  const skillsPath = path.join(projectPath, '.claude', 'skills');

  const hasClaudeMd = fs.existsSync(claudeMdPath);
  const hasSkills = fs.existsSync(skillsPath);

  if (!hasClaudeMd) {
    return `⚠️ ${projectName}: CLAUDE.md 없음. Claude가 프로젝트 컨텍스트 없이 작업합니다.`;
  }
  if (!hasSkills) {
    return `⚠️ ${projectName}: .claude/skills/ 없음. 커밋/PR 컨벤션 미적용.`;
  }
  return null;
}

// ─── Claude 응답에서 구조화된 JSON 추출 ───
function parseWorkOutput(text, fallbackPrompt) {
  const defaults = {
    summary: '자동 작업 완료',
    commit_message: 'feat: 자동 작업',
    pr_title: (fallbackPrompt || '').slice(0, 60),
    files_changed: [],
  };

  try {
    // ```json ... ``` 블록 먼저 시도
    const fencedMatch = text.match(/```json\s*([\s\S]*?)```/);
    if (fencedMatch) {
      return { ...defaults, ...JSON.parse(fencedMatch[1].trim()) };
    }
    // 날것의 JSON 객체 시도
    const rawMatch = text.match(/\{[\s\S]*"summary"[\s\S]*?"commit_message"[\s\S]*?\}/);
    if (rawMatch) {
      return { ...defaults, ...JSON.parse(rawMatch[0]) };
    }
  } catch {}

  return defaults;
}

// ─── 프롬프트 빌더 ───

function buildPlanPrompt(taskDescription, issueNumber, projectInfo) {
  return `
# 작업 계획 수립

## Task
${taskDescription}
${issueNumber ? `\n## Issue: #${issueNumber}` : ''}

## 지침
- 코드를 수정하지 마. 계획만 세워.
- 관련 디렉토리 구조와 기존 코드를 먼저 파악해.
- 아래 항목을 정리해:

1. **변경 대상 파일** — 수정/생성할 파일 목록과 이유
2. **구현 순서** — 어떤 순서로 작업할지
3. **기존 패턴** — 이 프로젝트에서 이미 쓰고 있는 패턴 중 따라야 할 것
4. **리스크** — 주의할 점, 깨질 수 있는 부분
5. **테스트 전략** — 어떤 테스트를 추가/수정할지

## 금지
- 실제 코드 수정
- 새 패턴 도입 제안 (기존 패턴만 사용)
`.trim();
}

function buildExecPrompt(issueNumber) {
  return `
위 계획대로 구현해.

## 구현 규칙
- 기존 코드 패턴과 동일하게 구현
- 새 의존성 추가 금지 (필요하면 summary에 이유 명시)
- 변경 파일 최소화 — 관련 없는 파일 수정 금지
- 리팩토링과 기능 추가를 같은 변경에 섞지 말 것
- 테스트 작성 후 빌드/테스트 통과 확인

## 완료 후 출력
반드시 아래 JSON 형식으로 작업 결과를 출력해:

\`\`\`json
{
  "summary": "무엇을 왜 구현했는지 한국어 2~3문장",
  "commit_message": "type(scope): 제목 (conventional commits, 72자 이내)${issueNumber ? `\\n\\nCloses #${issueNumber}` : ''}",
  "pr_title": "type: 한국어 제목 (60자 이내)",
  "files_changed": ["변경된 파일 경로 목록"]
}
\`\`\`
`.trim();
}

function buildAskPrompt(question, projectName) {
  return `
# 기술 질문

## 프로젝트 컨텍스트
${projectName} 프로젝트 관련 질문이야.

## 질문
${question}

## 답변 형식
- 핵심 답변 먼저 (두괄식)
- 프로젝트 코드베이스에 맞는 구체적인 예시 포함
- 코드 예시는 실제 이 프로젝트에서 쓸 수 있는 것으로
- 길이: 충분히 상세하되 불필요한 설명 제거
  `.trim();
}

function buildGPTReviewPrompt(diff, claudeMd, taskDescription) {
  return `너는 시니어 개발자이고 코드 리뷰어다. 주어진 git diff를 리뷰해줘.

${claudeMd ? `## 프로젝트 컨벤션\n${claudeMd}\n` : ''}

## 구현 목표
${taskDescription || '(명시되지 않음)'}

## 심각도 기준
- **[높음]**: 런타임 에러, 데이터 손실, 보안 취약점 — 실제 장애가 나는 것만
- **[중간]**: 확실한 성능 문제 (N+1 쿼리 등), 확실한 로직 버그
- **[낮음]**: 컨벤션, 네이밍, 스타일, 개선 제안, 추측성 이슈

## 중요 규칙
- diff가 잘려 있는 것은 이슈가 아니다
- "~할 수 있음", "~가능성" 같은 추측은 낮음
- 높음/중간은 확실한 문제만. 애매하면 낮음

## 출력 형식
### 총평
한줄 요약

### 변경 파일
변경된 파일 목록과 각 파일의 변경 요약

### 이슈 목록
- **[높음]** 파일:라인 — 문제 — 제안
- **[중간]** 파일:라인 — 문제 — 제안
- **[낮음]** 파일:라인 — 문제 — 제안

이슈가 없으면 "이슈 없음"

### 잘한 점
좋은 구현이 있으면 언급

### 결론
- 높음/중간 없으면 → 승인(LGTM)
- 높음/중간 있으면 → 수정 필요
- 심각한 보안/설계 결함 → 반려

반드시 하나로 명시: 승인(LGTM) / 수정 필요 / 반려`;
}

function buildAutoFixPrompt(reviewText, attempt) {
  return `
# 리뷰 피드백 수정 (${attempt}차)

## GPT-5.4 리뷰 결과
${reviewText}

## 지침
- [높음], [중간] 이슈 모두 수정
- [낮음]은 판단하여 선택 수정
- 수정 후 빌드/테스트 재실행하여 통과 확인
- 관련 없는 코드 건드리지 말 것
- 이전 작업 맥락은 이미 알고 있으니 바로 수정에 집중
`.trim();
}

function buildIssueBodyPrompt(description, projectName) {
  return `
다음 설명을 기반으로 GitHub 이슈 본문을 작성해.
마크다운 형식, 한국어.

## 프로젝트
${projectName}

## 설명
${description}

## 출력 형식 (이 구조 그대로)

## 요약
[한 문장]

## 상세 요구사항
- [ ] [요구사항 1]
- [ ] [요구사항 2]

## 수용 기준 (Acceptance Criteria)
- [ ] [테스트 가능한 조건 1]
- [ ] [테스트 가능한 조건 2]

## 기술 힌트
[구현 방향이나 참고사항, 없으면 '없음']

## 출력 규칙
- 이슈 본문만 출력 (다른 텍스트 없이)
- 수용 기준은 반드시 테스트 가능한 형태로
- 모호한 요구사항은 구체적으로 재해석
  `.trim();
}

async function sendChunks(channel, text) {
  if (!text) { await channel.send('(출력 없음)'); return; }
  const maxLen = 1900;
  for (let i = 0; i < text.length; i += maxLen) {
    await channel.send('```\n' + text.slice(i, i + maxLen) + '\n```');
  }
}

async function ensureRepo(name) {
  const project = PROJECTS[name];
  const dir = path.join(WORKSPACE, name);

  if (!fs.existsSync(dir)) {
    await runCmd(`git clone ${project.repo} ${dir}`, WORKSPACE);
  } else {
    // dirty 상태 정리 후 base 브랜치로 복귀
    try {
      await runCmd('git reset HEAD -- . 2>/dev/null; git checkout -- . 2>/dev/null; git clean -fd 2>/dev/null', dir);
    } catch {}
    try {
      await runCmd(`git checkout ${project.branch}`, dir);
    } catch {}
    // pull 실패 시 재클론 (conflict 등 복구 불가 상태 대비)
    try {
      await runCmd(`git pull origin ${project.branch}`, dir);
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
      await runCmd(`git clone ${project.repo} ${dir}`, WORKSPACE);
    }
    // 이전 작업에서 남은 claude/* 브랜치 정리 (merge 완료된 것만 삭제)
    try {
      const branches = await runCmd('git branch --list claude/*', dir);
      if (branches) {
        for (const b of branches.split('\n').map(s => s.replace(/^\*\s*/, '').trim()).filter(Boolean)) {
          try { await runSpawn('git', ['branch', '-d', b], dir); } catch {}
        }
      }
    } catch {}
  }
  return dir;
}

// ─── PR 본문 생성 (Claude 요약 기반) ───
function buildPRBody(workOutput, issueNumber, review) {
  let body = `## Summary\n\n${workOutput.summary}\n\n`;
  body += `## Changes\n\n`;
  if (workOutput.files_changed && workOutput.files_changed.length > 0) {
    body += workOutput.files_changed.map(f => `- ${f}`).join('\n') + '\n\n';
  }
  if (issueNumber) {
    body += `## Related Issue\n\nCloses #${issueNumber}\n\n`;
  }
  if (review) {
    const lower = review.toLowerCase();
    let conclusion = '⚠️ 수정 필요';
    if (lower.includes('반려')) conclusion = '❌ 반려';
    else if (lower.includes('승인') || lower.includes('lgtm')) conclusion = '✅ 승인 (LGTM)';
    body += `## AI Review\n\n**결과:** ${conclusion}\n\n`;
  }
  body += '---\n> 🤖 Generated by **Claude Code Bot**';
  return body;
}

// ─── Issue 본문 생성 ───
async function generateIssueBody(taskDescription, projectName, changeSummary, prUrl) {
  try {
    const issuePrompt = buildIssueBodyPrompt(taskDescription, projectName);
    let body = await runOpenAIText(issuePrompt);

    if (prUrl) {
      body += `\n\n## Related PR\n\n${prUrl}`;
    }
    if (changeSummary && changeSummary.summary) {
      body += `\n\n## 변경사항 요약\n\n${changeSummary.summary}`;
      if (Array.isArray(changeSummary.changes)) {
        body += '\n' + changeSummary.changes.map(c => `- ${c}`).join('\n');
      }
    }

    return body + '\n\n---\n> 🤖 Generated by **Claude Code Bot**';
  } catch {
    const changesSection = Array.isArray(changeSummary?.changes)
      ? changeSummary.changes.map(c => `- ${c}`).join('\n')
      : '';
    const prSection = prUrl ? `## Related PR\n\n${prUrl}\n` : '';
    return `## Overview\n\n${changeSummary?.summary || taskDescription}\n\n## Changes\n\n${changesSection}\n\n${prSection}\n---\n> 🤖 Generated by **Claude Code Bot**`;
  }
}

// ─── GPT-5.4 리뷰 (cross-model review 유지) ───
async function reviewWithGPT(diff, claudeMd, taskDescription) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const systemPrompt = buildGPTReviewPrompt(diff, claudeMd, taskDescription);

  const response = await openai.responses.create({
    model: 'gpt-5.4',
    instructions: systemPrompt,
    input: `다음 코드 변경사항을 리뷰해줘:\n\n\`\`\`diff\n${diff.slice(0, 80000)}\n\`\`\``,
    reasoning: { effort: 'high' },
  });

  return response.output_text;
}

// ─── 리뷰 기능 ───
function isLGTM(review) {
  if (!review) return true;
  const lower = review.toLowerCase();
  if (lower.includes('반려')) return false;
  if (lower.includes('심각도: 높음') || lower.includes('[높음]')) return false;
  if (lower.includes('심각도: 중간') || lower.includes('[중간]')) return false;
  return true;
}

async function reviewCode(dir, branch, baseBranch, channel, taskDescription) {
  await channel.send('🔍 GPT-5.4 (high reasoning) 리뷰 시작...');

  const diff = await runCmd(`git diff ${baseBranch}...${branch}`, dir);
  if (!diff) {
    await channel.send('리뷰할 변경사항이 없습니다.');
    return { review: null, passed: true };
  }

  // CLAUDE.md 읽기 (프로젝트 컨벤션)
  let claudeMd = '';
  const claudeMdPath = path.join(dir, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    claudeMd = fs.readFileSync(claudeMdPath, 'utf-8');
  }

  const review = await reviewWithGPT(diff, claudeMd, taskDescription);
  const passed = isLGTM(review);
  return { review, passed };
}

async function autoFix(dir, reviewText, channel, attempt, sessionId) {
  await channel.send(`🔧 리뷰 피드백 자동 수정 중... (${attempt}차)`);

  const fixPrompt = buildAutoFixPrompt(reviewText, attempt);
  const result = await runClaude(fixPrompt, dir, { sessionId });

  const status = await runCmd('git status --porcelain', dir);
  if (status) {
    await runCmd('git add -A -- . ":!.env" ":!.env.*" ":!*.tmp" ":!*.log"', dir);
    await gitCommit(`refactor(review): ${attempt}차 리뷰 반영`, dir);
    await channel.send('✅ 수정 커밋 완료');
  }

  return result;
}

// ─── 이슈 번호 추출 ───
function extractIssueNumber(prompt) {
  const match = prompt.match(/(?:이슈|issue|#)\s*:?\s*#?(\d+)/i);
  return match ? match[1] : null;
}

// ─── 브랜치 정리 ───
async function cleanupBranch(dir, branch, baseBranch) {
  try { await runSpawn('git', ['checkout', '-f', baseBranch], dir); } catch {
    try { await runSpawn('git', ['checkout', '--detach', 'HEAD'], dir); } catch {}
  }
  try { await runSpawn('git', ['branch', '-D', branch], dir); } catch {}
  try { await runSpawn('git', ['push', 'origin', '--delete', branch], dir); } catch {}
}

async function squashBranchCommits(dir, baseBranch, finalMessage) {
  const count = parseInt(await runCmd(`git rev-list --count ${baseBranch}..HEAD`, dir), 10);
  if (isNaN(count) || count <= 1) return;

  const origHead = (await runCmd('git rev-parse HEAD', dir)).trim();

  try {
    await runCmd(`git reset --soft ${baseBranch}`, dir);
    const staged = await runCmd('git diff --cached --stat', dir);
    if (!staged) {
      await runCmd(`git reset --soft ${origHead}`, dir);
      return;
    }
    await gitCommit(finalMessage, dir);
  } catch (e) {
    try { await runCmd(`git reset --soft ${origHead}`, dir); } catch {}
    throw e;
  }
}

// ─── 공통 work 로직 (Plan → Execute → Review 파이프라인) ───
async function doWork(projectName, prompt, message) {
  const dir = await ensureRepo(projectName);
  const baseBranch = PROJECTS[projectName].branch;
  const startTime = Date.now();

  // 프로젝트 설정 확인
  const setupWarning = checkProjectSetup(dir, projectName);
  if (setupWarning) {
    await message.channel.send(setupWarning);
  }

  await message.channel.send('📥 코드 준비 완료');
  const branch = `claude/${Date.now()}`;
  await runCmd(`git checkout -b ${branch}`, dir);
  await message.channel.send(`🌿 브랜치: ${branch}`);

  // 이슈 번호 추출
  const issueNumber = extractIssueNumber(prompt);

  // /command 처리
  let isCustomCommand = false;
  let finalPrompt = prompt;
  const cmdMatch = prompt.match(/^\/([\w-]+)\s*(.*)/s);
  if (cmdMatch) {
    const cmdFile = path.join(dir, '.claude', 'commands', `${cmdMatch[1]}.md`);
    if (fs.existsSync(cmdFile)) {
      let template = fs.readFileSync(cmdFile, 'utf-8');
      template = template.replace(/\$ARGUMENTS/g, cmdMatch[2] || '');
      finalPrompt = template;
      isCustomCommand = true;
    }
  }

  // ── Phase 1: 계획 수립 ──
  let planSessionId = null;
  if (!isCustomCommand) {
    await message.channel.send('📋 작업 계획 수립 중...');
    const planPrompt = buildPlanPrompt(prompt, issueNumber, { name: projectName, path: dir });
    const planResult = await runClaude(planPrompt, dir);
    planSessionId = planResult.sessionId;
    // 계획을 디스코드에 공유
    await sendChunks(message.channel, planResult.text.slice(0, 2000));
  }

  // ── Phase 2: 구현 (세션 이어받기, 실패 시 새 세션 폴백) ──
  await message.channel.send('🤖 구현 중... (최대 10분)');
  let execResult;
  if (isCustomCommand) {
    execResult = await runClaude(finalPrompt, dir);
  } else {
    const execPrompt = buildExecPrompt(issueNumber);
    try {
      execResult = await runClaude(execPrompt, dir, { sessionId: planSessionId });
    } catch (resumeErr) {
      // --resume 실패 시 새 세션으로 폴백
      await message.channel.send('⚠️ 세션 이어받기 실패, 새 세션으로 재시도...');
      const fullPrompt = buildPlanPrompt(prompt, issueNumber, { name: projectName, path: dir }) + '\n\n' + execPrompt;
      execResult = await runClaude(fullPrompt, dir);
    }
  }

  const workSessionId = execResult.sessionId;
  const status = await runCmd('git status --porcelain', dir);

  if (!status) {
    await runCmd(`git checkout ${baseBranch}`, dir);
    try { await runCmd(`git branch -d ${branch}`, dir); } catch {}
    await message.channel.send('📋 코드 변경 없음');
    await sendChunks(message.channel, execResult.text.slice(0, 3800));
    return { changed: false };
  }

  // Claude 응답에서 구조화된 데이터 추출
  const workOutput = parseWorkOutput(execResult.text, prompt);

  // 커밋 (Claude가 생성한 커밋 메시지 사용)
  await runCmd('git add -A', dir);
  await gitCommit(workOutput.commit_message, dir);

  // ── Phase 3: GPT-5.4 리뷰 (cross-model) ──
  let reviewPassed = false;
  let lastReview = null;
  const reviewHistory = [];

  for (let attempt = 1; attempt <= MAX_REVIEW_RETRIES; attempt++) {
    await message.channel.send(`📝 리뷰 ${attempt}/${MAX_REVIEW_RETRIES}회차...`);
    const { review, passed } = await reviewCode(dir, branch, baseBranch, message.channel, prompt);
    lastReview = review;
    if (review) reviewHistory.push(review);

    if (review) await sendChunks(message.channel, review);

    if (passed) {
      await message.channel.send('✅ 리뷰 통과!');
      reviewPassed = true;
      break;
    }

    if (attempt === MAX_REVIEW_RETRIES) break;
    await message.channel.send(`⚠️ 수정 필요 → 자동 수정 (${attempt}/${MAX_REVIEW_RETRIES})`);
    // 같은 세션에서 수정 → Claude가 자기 작업 맥락을 유지 (실패 시 새 세션)
    try {
      await autoFix(dir, review, message.channel, attempt, workSessionId);
    } catch {
      await autoFix(dir, review, message.channel, attempt, null);
    }
  }

  if (!reviewPassed) {
    await message.channel.send(`🚫 리뷰 ${MAX_REVIEW_RETRIES}회 실패 — 중단\n브랜치 \`${branch}\`에 작업 내용이 남아 있습니다.\n\`!fix ${projectName} 수정내용\`으로 수동 수정 가능`);
    return { changed: true, pushed: false };
  }

  // 푸시
  await squashBranchCommits(dir, baseBranch, workOutput.commit_message);
  await runCmd(`git push origin ${branch}`, dir);

  // PR 생성 (Claude가 만든 요약 활용)
  const repoSlug = PROJECTS[projectName].repo.replace('https://github.com/', '').replace('.git', '');
  let prUrl = null;
  const tmpPrBody = path.join(dir, '.pr-body.tmp');
  try {
    const prBody = buildPRBody(workOutput, issueNumber, lastReview);
    fs.writeFileSync(tmpPrBody, prBody);
    prUrl = await runSpawn('gh', [
      'pr', 'create', '--repo', repoSlug,
      '--title', workOutput.pr_title,
      '--body-file', tmpPrBody,
      '--base', baseBranch,
      '--head', branch,
    ], dir);
    await message.channel.send(`📋 PR: ${prUrl}`);
  } catch (prErr) {
    await message.channel.send(`⚠️ PR 생성 실패: ${prErr.message.slice(0, 500)}`);
  } finally {
    if (fs.existsSync(tmpPrBody)) fs.unlinkSync(tmpPrBody);
  }

  // 이슈 생성
  const tmpIssueBody = path.join(dir, '.issue-body.tmp');
  try {
    const issueBody = await generateIssueBody(
      prompt, projectName,
      { summary: workOutput.summary, changes: workOutput.files_changed },
      prUrl,
    );
    fs.writeFileSync(tmpIssueBody, issueBody);
    const issueUrl = await runSpawn('gh', [
      'issue', 'create', '--repo', repoSlug,
      '--title', workOutput.pr_title,
      '--body-file', tmpIssueBody,
    ], dir);
    await message.channel.send(`📌 이슈: ${issueUrl}`);
  } catch (issueErr) {
    await message.channel.send(`⚠️ 이슈 생성 실패: ${issueErr.message.slice(0, 300)}`);
  } finally {
    if (fs.existsSync(tmpIssueBody)) fs.unlinkSync(tmpIssueBody);
  }

  // 작업 완료 후 base 브랜치로 복귀
  try {
    await runCmd(`git checkout ${baseBranch}`, dir);
  } catch {}

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  await message.channel.send(`✅ 완료! (${elapsed}초)`);
  await sendChunks(message.channel, workOutput.summary);
  return { changed: true, pushed: true };
}

// ─── 명령어 파싱 ───
function parseCommand(content) {
  // 멀티: !work blog-api,blog-web 작업
  const multiWorkMatch = content.match(/^!work\s+([\w-]+(?:,[\w-]+)+)\s+(.+)$/s);
  if (multiWorkMatch) {
    const projects = multiWorkMatch[1].split(',').map(p => p.trim());
    return { type: 'multi-work', projects, prompt: multiWorkMatch[2] };
  }

  const workMatch = content.match(/^!work\s+([\w-]+)\s+(.+)$/s);
  if (workMatch) return { type: 'work', project: workMatch[1], prompt: workMatch[2] };

  const askMatch = content.match(/^!ask\s+([\w-]+)\s+(.+)$/s);
  if (askMatch) return { type: 'ask', project: askMatch[1], prompt: askMatch[2] };

  const reviewMatch = content.match(/^!review\s+([\w-]+)$/);
  if (reviewMatch) return { type: 'review', project: reviewMatch[1] };

  const fixMatch = content.match(/^!fix\s+([\w-]+)\s+(.+)$/s);
  if (fixMatch) return { type: 'fix', project: fixMatch[1], prompt: fixMatch[2] };

  const issueMatch = content.match(/^!issue\s+([\w-]+)\s+(.+)$/s);
  if (issueMatch) return { type: 'issue', project: issueMatch[1], prompt: issueMatch[2] };

  if (content === '!status') return { type: 'status' };
  if (content === '!projects') return { type: 'projects' };
  if (content === '!help') return { type: 'help' };
  return null;
}

// ─── 자연어 파싱 ───
async function parseNaturalLanguage(text) {
  const projectNames = Object.keys(PROJECTS).join(', ');
  const prompt = `사용자가 디스코드에서 보낸 메시지를 분석해서 JSON으로만 응답해줘.

등록된 프로젝트: ${projectNames}

## 판단 기준
- 코드 수정/개발/추가/구현/리팩토링/버그수정/맞춰줘/통일/고쳐 → type: "work"
- 질문/설명/분석/어떻게/뭐야/알려줘 → type: "ask"
- 프로젝트가 여러 개면 projects 배열에 모두 포함
- 약칭 매칭: "api"→"blog-api", "web"→"blog-web", "ai"→"blog-ai"
- 프로젝트명이 없으면 projects를 빈 배열로

## 응답 (JSON만, 설명 없이)
{"type": "work", "projects": ["blog-api"], "prompt": "실제 작업 내용"}

메시지: ${text}`;

  try {
    const result = await runOpenAIText(prompt);
    const jsonMatch = result.match(/\{[\s\S]*?\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch {}
  return null;
}

// ─── 메시지 핸들러 ───
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== process.env.DISCORD_CHANNEL_ID) return;

  let cmd = parseCommand(message.content);

  // ! 명령어 아니면 자연어 체크 (봇 멘션 또는 봇 이름 포함)
  if (!cmd) {
    const content = message.content;
    const botMentioned = message.mentions.users.has(client.user.id);
    const botNameMentioned = content.toLowerCase().includes('claude') || content.toLowerCase().includes('클로드');

    if (botMentioned || botNameMentioned) {
      const text = content.replace(/<@!?\d+>/g, '').trim();
      if (!text) return;

      await message.reply('🧠 메시지 분석 중...');
      const parsed = await parseNaturalLanguage(text);

      if (!parsed || !parsed.projects || parsed.projects.length === 0) {
        await message.reply('프로젝트를 파악할 수 없습니다. 프로젝트명을 포함해주세요.\n등록된 프로젝트: ' + Object.keys(PROJECTS).join(', '));
        return;
      }

      if (parsed.projects.length > 1) {
        cmd = { type: 'multi-work', projects: parsed.projects, prompt: parsed.prompt };
      } else {
        cmd = { type: parsed.type || 'work', project: parsed.projects[0], prompt: parsed.prompt };
      }
    }
  }

  if (!cmd) return;

  // !help
  if (cmd.type === 'help') {
    await message.reply([
      '**명령어:**',
      '`!work <프로젝트> <작업>` — 코드 작업 → 리뷰 → PR + 이슈',
      '`!work api,web <작업>` — 멀티 프로젝트',
      '`!ask <프로젝트> <질문>` — 코드 분석',
      '`!review <프로젝트>` — 리뷰',
      '`!fix <프로젝트> <내용>` — 수정 반영',
      '`!issue <프로젝트> <제목> | <설명>` — 이슈 생성',
      '`!projects` / `!status`',
      '',
      '**자연어 (봇 멘션 또는 "claude" 포함):**',
      '`@bot api랑 web 구조 맞춰줘`',
      '`claude ai 크롤링 구조 설명해줘`',
    ].join('\n'));
    return;
  }

  if (cmd.type === 'projects') {
    const list = Object.entries(PROJECTS)
      .map(([name, p]) => `- **${name}**: ${p.repo}`)
      .join('\n');
    await message.reply(`등록된 프로젝트:\n${list}`);
    return;
  }

  if (cmd.type === 'status') {
    await message.reply(isWorking() ? '작업 진행 중입니다.' : '대기 중입니다.');
    return;
  }

  // ─── 멀티 프로젝트 ───
  if (cmd.type === 'multi-work') {
    const invalid = cmd.projects.filter(p => !PROJECTS[p]);
    if (invalid.length > 0) {
      await message.reply(`프로젝트 없음: ${invalid.join(', ')}. 등록: ${Object.keys(PROJECTS).join(', ')}`);
      return;
    }
    if (isWorking()) { await message.reply('이전 작업 진행 중입니다.'); return; }
    setWorking(true);
    await message.reply(`🔧 멀티 프로젝트: ${cmd.projects.join(', ')}\n작업: ${cmd.prompt}`);

    try {
      for (const projectName of cmd.projects) {
        await message.channel.send(`\n━━━ **${projectName}** ━━━`);
        try {
          await doWork(projectName, cmd.prompt, message);
        } catch (err) {
          await message.channel.send(`❌ **${projectName}** 에러: ${err.message.slice(0, 500)}`);
          try { await runCmd(`git checkout ${PROJECTS[projectName].branch}`, path.join(WORKSPACE, projectName)); } catch {}
        }
      }
      await message.channel.send('🏁 멀티 프로젝트 전체 완료!');
    } finally {
      setWorking(false);
    }
    return;
  }

  // 프로젝트 검증
  if (!PROJECTS[cmd.project]) {
    await message.reply(`프로젝트 "${cmd.project}" 없음. 등록: ${Object.keys(PROJECTS).join(', ')}`);
    return;
  }

  if (isWorking()) { await message.reply('이전 작업 진행 중입니다.'); return; }
  setWorking(true);
  const baseBranch = PROJECTS[cmd.project].branch;

  try {
    const dir = await ensureRepo(cmd.project);

    // ─── !issue ───
    if (cmd.type === 'issue') {
      const [title, ...bodyParts] = cmd.prompt.split('|');
      const description = bodyParts.join('|').trim() || title.trim();
      const repoSlug = PROJECTS[cmd.project].repo.replace('https://github.com/', '').replace('.git', '');

      await message.reply(`📝 **${cmd.project}** 이슈 본문 생성 중...`);
      let body;
      try {
        body = await runOpenAIText(buildIssueBodyPrompt(description, cmd.project));
      } catch {
        body = description;
      }

      const tmpBody = path.join(dir, '.issue-body.tmp');
      try {
        fs.writeFileSync(tmpBody, body + '\n\n---\n> 🤖 Generated by **Claude Code Bot**');
        const issueUrl = await runSpawn('gh', [
          'issue', 'create', '--repo', repoSlug,
          '--title', title.trim(),
          '--body-file', tmpBody,
        ], dir);
        await message.reply(`📌 이슈: ${issueUrl}`);
      } catch (err) {
        await message.reply(`❌ 이슈 생성 실패: ${err.message.slice(0, 500)}`);
      } finally {
        if (fs.existsSync(tmpBody)) fs.unlinkSync(tmpBody);
      }
      return;
    }

    // ─── !ask ───
    if (cmd.type === 'ask') {
      await message.reply(`🔍 **${cmd.project}** 분석 중...`);
      const askPrompt = buildAskPrompt(cmd.prompt, cmd.project);
      const result = await runClaude(askPrompt, dir);
      await sendChunks(message.channel, result.text);
      return;
    }

    // ─── !review ───
    if (cmd.type === 'review') {
      await message.reply(`🔍 **${cmd.project}** 리뷰 중...`);
      const currentBranch = await runCmd('git branch --show-current', dir);
      const { review } = await reviewCode(dir, currentBranch, baseBranch, message.channel);
      if (review) await sendChunks(message.channel, review);
      return;
    }

    // ─── !work ───
    if (cmd.type === 'work') {
      await message.reply(`🔧 **${cmd.project}** 작업 시작: ${cmd.prompt}`);
      await doWork(cmd.project, cmd.prompt, message);
      return;
    }

    // ─── !fix ───
    if (cmd.type === 'fix') {
      await message.reply(`🔧 **${cmd.project}** 수정 중: ${cmd.prompt}`);
      const currentBranch = await runCmd('git branch --show-current', dir);
      if (currentBranch === baseBranch) {
        await message.reply('작업 브랜치가 없습니다. !work로 먼저 작업하세요.');
        return;
      }
      await message.channel.send('🤖 수정 중...');
      const fixPrompt = `
# 수동 수정 요청

## 수정 내용
${cmd.prompt}

## 지침
- 요청한 부분만 정확히 수정
- 수정 후 빌드/테스트 통과 확인
- 관련 없는 코드 건드리지 말 것
`.trim();
      const result = await runClaude(fixPrompt, dir);
      const fixStatus = await runCmd('git status --porcelain', dir);
      if (fixStatus) {
        await runCmd('git add -A -- . ":!.env" ":!.env.*" ":!*.tmp" ":!*.log"', dir);
        // Claude에게 커밋 메시지도 생성 요청
        const msgResult = await runClaude(
          '방금 수정한 내용에 대해 conventional commits 형식의 커밋 메시지를 한 줄만 출력해. 다른 텍스트 없이.',
          dir,
          { sessionId: result.sessionId },
        );
        const commitMsg = msgResult.text.split('\n')[0].replace(/^["'`]+|["'`]+$/g, '').trim().slice(0, 72) || 'fix: 수동 수정';
        await gitCommit(commitMsg, dir);
        await runCmd(`git push origin ${currentBranch}`, dir);
        await message.channel.send('✅ 수정 푸시 완료');
      }
      await sendChunks(message.channel, result.text.slice(0, 3800));
      return;
    }

  } catch (err) {
    await message.reply(`❌ 에러: ${err.message.slice(0, 1500)}`);
    try {
      const errDir = path.join(WORKSPACE, cmd.project);
      const cur = await runCmd('git branch --show-current', errDir);
      if (cur.startsWith('claude/') && baseBranch) await runSpawn('git', ['checkout', '-f', baseBranch], errDir);
    } catch {}
  } finally {
    setWorking(false);
  }
});

// ─── 시작 ───
client.once('ready', () => {
  console.log(`Bot ready: ${client.user.tag}`);
  console.log(`Channel: ${process.env.DISCORD_CHANNEL_ID}`);
  console.log(`Projects: ${Object.keys(PROJECTS).join(', ')}`);
});

client.login(process.env.DISCORD_TOKEN);
