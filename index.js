require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');

// ─── Configuration ───
const WORKSPACE = path.join(__dirname, 'repos');
const MAX_REVIEW_RETRIES = 3;
const OPENAI_MODEL = 'gpt-4.1-mini';

// ─── Shared OpenAI text helper ───
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
  'dev-orchestrator': {
    repo: 'https://github.com/seeeeeeong/dev-orchestrator.git',
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

// ─── Working flag (file-based and survives bot restarts) ───
const LOCK_FILE = path.join(__dirname, '.working.lock');

function isWorking() {
  if (!fs.existsSync(LOCK_FILE)) return false;
  // Treat locks older than 1 hour as stale from a previous crash.
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

// ─── Utilities ───
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
    const safeMsg = raw.trim() || 'feat: automated update';
    const proc = spawn('git', ['commit', '-m', safeMsg], { cwd, env: process.env });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (code) =>
      code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || stdout))
    );
  });
}

// ─── Claude CLI (JSON output with session continuity) ───
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
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 1800000,
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
        // Fall back to plain text if JSON parsing fails.
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

// Strip warning messages from Claude CLI output.
function cleanOutput(text) {
  return text
    .replace(/Warning: no stdin data received.*\n?/g, '')
    .replace(/If piping from a slow command.*\n?/g, '')
    .trim();
}

// ─── Project setup check ───
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

// ─── Extract structured JSON from Claude output ───
function parseWorkOutput(text, fallbackPrompt) {
  const defaults = {
    summary: 'Automated work completed.',
    commit_message: 'feat: automated update',
    pr_title: (fallbackPrompt || '').slice(0, 60),
    files_changed: [],
  };

  try {
    // Try a fenced ```json ... ``` block first.
    const fencedMatch = text.match(/```json\s*([\s\S]*?)```/);
    if (fencedMatch) {
      return { ...defaults, ...JSON.parse(fencedMatch[1].trim()) };
    }
    // Then try a raw JSON object.
    const rawMatch = text.match(/\{[\s\S]*"summary"[\s\S]*?"commit_message"[\s\S]*?\}/);
    if (rawMatch) {
      return { ...defaults, ...JSON.parse(rawMatch[0]) };
    }
  } catch {}

  return defaults;
}

// ─── Prompt builders ───

function buildPlanPrompt(taskDescription, issueNumber, projectInfo) {
  return `
# Build an Implementation Plan

## Task
${taskDescription}
${issueNumber ? `\n## Issue: #${issueNumber}` : ''}

## Instructions
- Do not edit code yet. Produce a plan only.
- Inspect the relevant directory structure and existing code first.
- Cover the items below:

1. **Target files** - Files to modify or create, and why
2. **Implementation order** - Recommended execution sequence
3. **Existing patterns** - Patterns already used in this project that should be followed
4. **Risks** - Things that may break or require care
5. **Test strategy** - Tests to add or update

## Do Not
- Modify code
- Propose a brand-new pattern when an existing one already fits
`.trim();
}

function buildExecPrompt(issueNumber) {
  return `
Implement the work according to the approved plan.

## Implementation Rules
- Follow the existing code patterns in this project
- Do not add new dependencies unless absolutely necessary. If you do, explain why in "summary"
- Keep the file set minimal and avoid unrelated edits
- Do not mix refactoring and feature work unless the refactor is directly required
- Add or update tests, then verify build and test results

## Output
Return the final result in the exact JSON format below:

\`\`\`json
{
  "summary": "2-3 concise English sentences explaining what changed and why",
  "commit_message": "type(scope): concise English title (Conventional Commits, <= 72 chars)${issueNumber ? `\\n\\nCloses #${issueNumber}` : ''}",
  "pr_title": "type(scope): concise English PR title (<= 60 chars)",
  "files_changed": ["list of changed file paths"]
}
\`\`\`
`.trim();
}

function buildAskPrompt(question, projectName) {
  return `
# Technical Question

## Project Context
This question is about the ${projectName} project.

## Question
${question}

## Response Format
- Lead with the core answer
- Include concrete examples grounded in this codebase
- Use examples that could realistically be applied in this project
- Be detailed enough to be useful, but avoid filler
  `.trim();
}

function buildGPTReviewPrompt(diff, claudeMd, taskDescription) {
  return `You are a senior engineer and code reviewer. Review the provided git diff.

${claudeMd ? `## Project Conventions\n${claudeMd}\n` : ''}

## Implementation Goal
${taskDescription || '(not specified)'}

## Severity Guide
- **[high]**: runtime errors, data loss, security vulnerabilities, or other concrete production failures
- **[medium]**: definite logic bugs or confirmed performance problems such as N+1 queries
- **[low]**: conventions, naming, style, improvement ideas, or speculative concerns

## Important Rules
- A truncated diff is not an issue by itself
- Speculative claims such as "might" or "could" should be treated as low severity
- Only classify something as high or medium when the problem is clear and defensible. If uncertain, mark it low

## Output Format
### Summary
One-line overall assessment

### Changed Files
List changed files and briefly summarize what changed in each

### Findings
- **[high]** file:line - problem - recommendation
- **[medium]** file:line - problem - recommendation
- **[low]** file:line - problem - recommendation

If there are no issues, write "No issues".

### Strengths
Mention notable implementation strengths when they exist

### Verdict
- If there are no high or medium findings -> Approve (LGTM)
- If there are high or medium findings -> Needs changes
- If there is a severe security or design flaw -> Reject

State exactly one final verdict: Approve (LGTM) / Needs changes / Reject`;
}

function buildAutoFixPrompt(reviewText, attempt) {
  return `
# Address Review Feedback (Attempt ${attempt})

## GPT-5.4 Review Output
${reviewText}

## Instructions
- Fix all [high] and [medium] findings
- Use judgment for [low] findings
- Re-run build and test verification after making changes
- Do not touch unrelated code
- Prior context is already known, so focus directly on the fixes
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
    // Clean up a dirty worktree, then return to the base branch.
    try {
      await runCmd('git reset HEAD -- . 2>/dev/null; git checkout -- . 2>/dev/null; git clean -fd 2>/dev/null', dir);
    } catch {}
    try {
      await runCmd(`git checkout ${project.branch}`, dir);
    } catch {}
    // Re-clone if pull fails, for example when the repo is unrecoverably conflicted.
    try {
      await runCmd(`git pull origin ${project.branch}`, dir);
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
      await runCmd(`git clone ${project.repo} ${dir}`, WORKSPACE);
    }
    // Remove leftover claude/* branches from earlier work, but only if fully merged.
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

// ─── PR body generation from Claude output ───
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
    let conclusion = '⚠️ Needs changes';
    if (lower.includes('reject') || lower.includes('rejected') || lower.includes('반려')) conclusion = '❌ Reject';
    else if (lower.includes('approve') || lower.includes('approved') || lower.includes('승인') || lower.includes('lgtm')) conclusion = '✅ Approve (LGTM)';
    body += `## AI Review\n\n**Verdict:** ${conclusion}\n\n`;
  }
  body += '---\n> 🤖 Generated by **Claude Code Bot**';
  return body;
}

// ─── Issue body generation ───
async function generateIssueBody(taskDescription, projectName, changeSummary, prUrl) {
  try {
    const issuePrompt = buildIssueBodyPrompt(taskDescription, projectName);
    let body = await runOpenAIText(issuePrompt);

    if (prUrl) {
      body += `\n\n## Related PR\n\n${prUrl}`;
    }
    if (changeSummary && changeSummary.summary) {
      body += `\n\n## Change Summary\n\n${changeSummary.summary}`;
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

// ─── GPT-5.4 review (keep cross-model review) ───
async function reviewWithGPT(diff, claudeMd, taskDescription) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const systemPrompt = buildGPTReviewPrompt(diff, claudeMd, taskDescription);

  const response = await openai.responses.create({
    model: 'gpt-5.4',
    instructions: systemPrompt,
    input: `Review the following code changes:\n\n\`\`\`diff\n${diff.slice(0, 80000)}\n\`\`\``,
    reasoning: { effort: 'high' },
  });

  return response.output_text;
}

// ─── Review helpers ───
function isLGTM(review) {
  if (!review) return true;
  const lower = review.toLowerCase();
  if (lower.includes('reject') || lower.includes('rejected') || lower.includes('반려')) return false;
  if (lower.includes('severity: high') || lower.includes('[high]') || lower.includes('심각도: 높음') || lower.includes('[높음]')) return false;
  if (lower.includes('severity: medium') || lower.includes('[medium]') || lower.includes('심각도: 중간') || lower.includes('[중간]')) return false;
  return true;
}

async function reviewCode(dir, branch, baseBranch, channel, taskDescription) {
  await channel.send('🔍 GPT-5.4 (high reasoning) 리뷰 시작...');

  const diff = await runCmd(`git diff ${baseBranch}...${branch}`, dir);
  if (!diff) {
    await channel.send('리뷰할 변경사항이 없습니다.');
    return { review: null, passed: true };
  }

  // Read CLAUDE.md for project conventions.
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
    await gitCommit(`refactor(review): address review feedback ${attempt}`, dir);
    await channel.send('✅ 수정 커밋 완료');
  }

  return result;
}

// ─── Issue number extraction ───
function extractIssueNumber(prompt) {
  const match = prompt.match(/(?:이슈|issue|#)\s*:?\s*#?(\d+)/i);
  return match ? match[1] : null;
}

// ─── Branch cleanup ───
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

// ─── Shared work flow (Plan -> Execute -> Review pipeline) ───
async function doWork(projectName, prompt, message) {
  const dir = await ensureRepo(projectName);
  const baseBranch = PROJECTS[projectName].branch;
  const startTime = Date.now();

  // Check project setup.
  const setupWarning = checkProjectSetup(dir, projectName);
  if (setupWarning) {
    await message.channel.send(setupWarning);
  }

  await message.channel.send('📥 코드 준비 완료');
  const branch = `claude/${Date.now()}`;
  await runCmd(`git checkout -b ${branch}`, dir);
  await message.channel.send(`🌿 브랜치: ${branch}`);

  // Extract the issue number from the prompt.
  const issueNumber = extractIssueNumber(prompt);

  // Expand /command templates when present.
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

  // ── Phase 1: planning ──
  let planSessionId = null;
  if (!isCustomCommand) {
    await message.channel.send('📋 작업 계획 수립 중...');
    const planPrompt = buildPlanPrompt(prompt, issueNumber, { name: projectName, path: dir });
    const planResult = await runClaude(planPrompt, dir);
    planSessionId = planResult.sessionId;
    // Share the plan in Discord.
    await sendChunks(message.channel, planResult.text.slice(0, 2000));
  }

  // ── Phase 2: execution (resume session when possible, otherwise fall back) ──
  await message.channel.send('🤖 구현 중... (최대 10분)');
  let execResult;
  if (isCustomCommand) {
    execResult = await runClaude(finalPrompt, dir);
  } else {
    const execPrompt = buildExecPrompt(issueNumber);
    try {
      execResult = await runClaude(execPrompt, dir, { sessionId: planSessionId });
    } catch (resumeErr) {
      // Fall back to a new session if `--resume` fails.
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

  // Extract structured data from the Claude response.
  const workOutput = parseWorkOutput(execResult.text, prompt);

  // Commit using the message generated by Claude.
  await runCmd('git add -A', dir);
  await gitCommit(workOutput.commit_message, dir);

  // ── Phase 3: GPT-5.4 review (cross-model) ──
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
    // Fix in the same session to preserve Claude's working context, with fallback if needed.
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

  // Push the work branch.
  await squashBranchCommits(dir, baseBranch, workOutput.commit_message);
  await runCmd(`git push origin ${branch}`, dir);

  // Create the PR using Claude's structured summary.
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

  // Create a follow-up issue.
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

  // Return to the base branch after the work completes.
  try {
    await runCmd(`git checkout ${baseBranch}`, dir);
  } catch {}

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  await message.channel.send(`✅ 완료! (${elapsed}초)`);
  await sendChunks(message.channel, workOutput.summary);
  return { changed: true, pushed: true };
}

// ─── Command parsing ───
function parseCommand(content) {
  // Multi-project form: !work blog-api,blog-web <task>
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

// ─── Natural-language parsing ───
async function parseNaturalLanguage(text) {
  const projectNames = Object.keys(PROJECTS).join(', ');
  const prompt = `Analyze the Discord message below and respond with JSON only.

Registered projects: ${projectNames}

## Classification Rules
- If the user asks for code changes, implementation, refactoring, fixes, alignment, or cleanup such as "수정", "구현", "리팩토링", "고쳐", set type to "work"
- If the user asks for explanation, analysis, or questions such as "질문", "설명", "분석", "어떻게", "뭐야", "알려줘", set type to "ask"
- If multiple projects are mentioned, include all of them in the \`projects\` array
- Alias mapping: "api" -> "blog-api", "web" -> "blog-web", "ai" -> "blog-ai"
- If no project is identified, return an empty \`projects\` array

## Response
Return JSON only, with no explanation.
{"type": "work", "projects": ["blog-api"], "prompt": "actual task description"}

Message: ${text}`;

  try {
    const result = await runOpenAIText(prompt);
    const jsonMatch = result.match(/\{[\s\S]*?\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch {}
  return null;
}

// ─── Message handler ───
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== process.env.DISCORD_CHANNEL_ID) return;

  let cmd = parseCommand(message.content);

  // If it is not a direct command, try natural-language parsing when the bot is mentioned.
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

  // ─── Multi-project flow ───
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

  // Validate the target project.
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
# Manual Fix Request

## Requested Change
${cmd.prompt}

## Instructions
- Modify only the requested area
- Verify that build and tests pass after the change
- Do not touch unrelated code
`.trim();
      const result = await runClaude(fixPrompt, dir);
      const fixStatus = await runCmd('git status --porcelain', dir);
      if (fixStatus) {
        await runCmd('git add -A -- . ":!.env" ":!.env.*" ":!*.tmp" ":!*.log"', dir);
        // Ask Claude to generate the commit message as well.
        const msgResult = await runClaude(
          'Based on the fix you just made, output exactly one Conventional Commits commit message line in English. No extra text.',
          dir,
          { sessionId: result.sessionId },
        );
        const commitMsg = msgResult.text.split('\n')[0].replace(/^["'`]+|["'`]+$/g, '').trim().slice(0, 72) || 'fix: apply manual fix';
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

// ─── Startup ───
client.once('ready', () => {
  console.log(`Bot ready: ${client.user.tag}`);
  console.log(`Channel: ${process.env.DISCORD_CHANNEL_ID}`);
  console.log(`Projects: ${Object.keys(PROJECTS).join(', ')}`);
});

client.login(process.env.DISCORD_TOKEN);
