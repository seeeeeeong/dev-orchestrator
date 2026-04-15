require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');

// ─── 설정 ───
const WORKSPACE = path.join(__dirname, 'repos');
const MAX_REVIEW_RETRIES = 5;
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

let working = false;

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
    const safeMsg = (message || 'feat: 자동 작업').trim() || 'feat: 자동 작업';
    const proc = spawn('git', ['commit', '-m', safeMsg], { cwd, env: process.env });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (code) =>
      code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || stdout))
    );
  });
}

function runClaude(prompt, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', [
      '-p', prompt,
      '--output-format', 'text',
      '--dangerously-skip-permissions',
      '--model', 'claude-opus-4-6',
    ], {
      cwd,
      env: process.env,
      timeout: 600000,
    });

    let output = '';
    proc.stdout.on('data', (d) => (output += d));
    proc.stderr.on('data', (d) => (output += d));
    proc.on('close', () => resolve(cleanOutput(output.trim())));
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
    try {
      // dirty 상태 정리 후 base 브랜치로 복귀
      await runCmd('git reset HEAD -- . 2>/dev/null; git checkout -- . 2>/dev/null; git clean -fd 2>/dev/null', dir);
      await runCmd(`git checkout ${project.branch}`, dir);
      await runCmd(`git pull origin ${project.branch}`, dir);
    } catch {}
  }
  return dir;
}

// ─── Claude로 커밋 메시지 생성 ───
async function generateCommitMsg(dir) {
  const diffContent = await runCmd('git diff --cached', dir);
  const prompt = `아래 git diff를 보고 커밋 메시지를 작성해.

규칙:
- Conventional Commits 형식 (feat:, fix:, refactor:, chore: 등)
- 한국어, 50자 이내
- 메시지 한 줄만 출력 (설명, 따옴표, 백틱 금지)

diff:
${diffContent.slice(0, 5000)}`;

  try {
    const msg = await runClaude(prompt, dir);
    const cleaned = msg.split('\n')[0].replace(/^["'`]|["'`]$/g, '').trim().slice(0, 50);
    if (cleaned) return cleaned;
  } catch {}
  return 'feat: 자동 작업';
}

// ─── Claude로 제목 생성 ───
async function generateTitle(prompt, result) {
  const genPrompt = `아래 작업 정보를 보고 GitHub 제목을 생성해. 제목 텍스트만 출력해.

규칙:
- Conventional Commits 형식 (feat:, fix:, refactor: 등)
- 한국어, 60자 이내
- 제목만 출력 (설명, 따옴표, 백틱 금지)

작업 요청: ${prompt}
작업 결과: ${(result || '').slice(0, 2000)}`;

  try {
    const raw = await runClaude(genPrompt, WORKSPACE);
    const cleaned = raw.split('\n')[0].replace(/^["'`]|["'`]$/g, '').trim().slice(0, 60);
    if (cleaned) return cleaned;
  } catch {}
  return prompt.slice(0, 60);
}

// ─── 변경 파일 요약 생성 ───
async function generateChangeSummary(dir, baseBranch, branch) {
  let diffStat, diffContent;
  try {
    diffStat = await runCmd(`git diff --stat ${baseBranch}...${branch}`, dir);
    diffContent = await runCmd(`git diff ${baseBranch}...${branch}`, dir);
  } catch {
    return { summary: '변경사항 요약 생성 실패 (diff 실행 오류)', changes: [] };
  }

  const genPrompt = `아래 diff를 분석하고 JSON으로만 응답해.

규칙:
- summary: 전체 변경사항 1~2줄 요약 (한국어)
- changes: 변경된 파일별 한 줄 설명 배열 (파일명: 설명 형식)
- JSON 외 텍스트 출력 금지

diff stat:
${diffStat}

diff:
${diffContent.slice(0, 8000)}

응답 형식:
{"summary": "...", "changes": ["index.js: 커밋 메시지 생성 로직 개선", ...]}`;

  try {
    const raw = await runClaude(genPrompt, WORKSPACE);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch {}
  return { summary: '변경사항 요약 생성 실패', changes: diffStat.split('\n').filter(l => l.trim()) };
}

// ─── PR 본문 생성 ───
function buildPRBody(summary, changes, review) {
  const changesSection = Array.isArray(changes)
    ? changes.map(c => `- ${c}`).join('\n')
    : String(changes);

  let reviewSection = '';
  if (review) {
    const lower = review.toLowerCase();
    let conclusion;
    if (lower.includes('반려')) {
      conclusion = '❌ 반려';
    } else if (lower.includes('승인') || lower.includes('lgtm')) {
      conclusion = '✅ 승인 (LGTM)';
    } else {
      conclusion = '⚠️ 수정 필요';
    }
    reviewSection = `## Review\n\n**결과:** ${conclusion}\n`;
  }

  return [
    `## Summary`,
    ``,
    `${summary}`,
    ``,
    `## Changes`,
    ``,
    changesSection,
    ``,
    reviewSection,
    `---`,
    `> 🤖 Generated by **Claude Code Bot**`,
  ].filter(l => l !== undefined).join('\n').replace(/\n{3,}/g, '\n\n');
}

// ─── Issue 본문 생성 ───
function buildIssueBody(summary, changes, prUrl) {
  const changesSection = Array.isArray(changes)
    ? changes.map(c => `- ${c}`).join('\n')
    : String(changes);

  const prSection = prUrl ? `## Related PR\n\n${prUrl}\n` : '';

  return [
    `## Overview`,
    ``,
    `${summary}`,
    ``,
    `## Changes`,
    ``,
    changesSection,
    ``,
    prSection,
    `---`,
    `> 🤖 Generated by **Claude Code Bot**`,
  ].filter(l => l !== undefined).join('\n').replace(/\n{3,}/g, '\n\n');
}

// ─── GPT-5.4 리뷰 ───
async function reviewWithGPT(diff, claudeMd) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const systemPrompt = `너는 시니어 백엔드 개발자이고 코드 리뷰어다. 주어진 git diff를 리뷰해줘.

${claudeMd ? `## 프로젝트 컨벤션\n${claudeMd}\n` : ''}

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

async function reviewCode(dir, branch, baseBranch, channel) {
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

  const review = await reviewWithGPT(diff, claudeMd);
  const passed = isLGTM(review);
  return { review, passed };
}

async function autoFix(dir, reviewText, channel) {
  await channel.send('🔧 리뷰 피드백 자동 수정 중...');

  const fixPrompt = `코드 리뷰에서 다음 문제들이 발견되었다. 이 피드백을 반영해서 코드를 수정해줘.

## 리뷰 피드백
${reviewText}

## 주의
- 리뷰에서 지적한 문제만 수정해
- 불필요한 변경 하지 마
- CLAUDE.md 컨벤션 지켜`;

  const result = await runClaude(fixPrompt, dir);

  const status = await runCmd('git status --porcelain', dir);
  if (status) {
    await runCmd('git add -A', dir);
    const fixMsg = await generateCommitMsg(dir);
    await gitCommit(fixMsg, dir);
    await channel.send('✅ 수정 커밋 완료');
  }

  return result;
}

// ─── 공통 work 로직 ───
async function doWork(projectName, prompt, message) {
  const dir = await ensureRepo(projectName);
  const baseBranch = PROJECTS[projectName].branch;
  const startTime = Date.now();

  await message.channel.send('📥 코드 준비 완료');
  const branch = `claude/${Date.now()}`;
  await runCmd(`git checkout -b ${branch}`, dir);
  await message.channel.send(`🌿 브랜치: ${branch}`);
  await message.channel.send('🤖 Claude 작업 중... (최대 10분)');

  // /command 처리
  let finalPrompt = prompt;
  const cmdMatch = prompt.match(/^\/([\w-]+)\s*(.*)/s);
  if (cmdMatch) {
    const cmdFile = path.join(dir, '.claude', 'commands', `${cmdMatch[1]}.md`);
    if (fs.existsSync(cmdFile)) {
      let template = fs.readFileSync(cmdFile, 'utf-8');
      template = template.replace(/\$ARGUMENTS/g, cmdMatch[2] || '');
      finalPrompt = template;
    }
  }

  const result = await runClaude(finalPrompt, dir);
  const status = await runCmd('git status --porcelain', dir);

  if (!status) {
    await runCmd(`git checkout ${baseBranch}`, dir);
    await runCmd(`git branch -d ${branch}`, dir);
    await message.channel.send('📋 코드 변경 없음');
    await sendChunks(message.channel, result.slice(0, 3800));
    return { changed: false };
  }

  // 커밋 (Claude가 메시지 생성)
  await runCmd('git add -A', dir);
  const commitMsg = await generateCommitMsg(dir);
  await gitCommit(commitMsg, dir);

  // 리뷰 루프
  let reviewPassed = false;
  let lastReview = null;

  for (let attempt = 1; attempt <= MAX_REVIEW_RETRIES; attempt++) {
    await message.channel.send(`📝 리뷰 ${attempt}/${MAX_REVIEW_RETRIES}회차...`);
    const { review, passed } = await reviewCode(dir, branch, baseBranch, message.channel);
    lastReview = review;

    if (review) await sendChunks(message.channel, review);

    if (passed) {
      await message.channel.send('✅ 리뷰 통과!');
      reviewPassed = true;
      break;
    }

    if (attempt === MAX_REVIEW_RETRIES) break;
    await message.channel.send(`⚠️ 수정 필요 → 자동 수정 (${attempt}/${MAX_REVIEW_RETRIES})`);
    await autoFix(dir, review, message.channel);
  }

  if (!reviewPassed) {
    await message.channel.send(`🚫 리뷰 ${MAX_REVIEW_RETRIES}회 실패 — 중단\n\`!fix ${projectName} 수정내용\`으로 수동 수정 가능`);
    return { changed: true, pushed: false };
  }

  // 푸시
  await runCmd(`git push origin ${branch}`, dir);

  // 제목 + 변경사항 요약 생성
  const repoSlug = PROJECTS[projectName].repo.replace('https://github.com/', '').replace('.git', '');
  const [title, changeSummary] = await Promise.all([
    generateTitle(prompt, result),
    generateChangeSummary(dir, baseBranch, branch),
  ]);

  // PR 생성
  let prUrl = null;
  const tmpPrBody = path.join(dir, '.pr-body.tmp');
  try {
    const prBody = buildPRBody(changeSummary.summary, changeSummary.changes, lastReview);
    fs.writeFileSync(tmpPrBody, prBody);
    prUrl = await runSpawn('gh', [
      'pr', 'create', '--repo', repoSlug,
      '--title', title,
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
    const issueBody = buildIssueBody(changeSummary.summary, changeSummary.changes, prUrl);
    fs.writeFileSync(tmpIssueBody, issueBody);
    const issueUrl = await runSpawn('gh', [
      'issue', 'create', '--repo', repoSlug,
      '--title', title,
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
  await sendChunks(message.channel, result.slice(0, 3800));
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
    const result = await runClaude(prompt, WORKSPACE);
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
    await message.reply(working ? '작업 진행 중입니다.' : '대기 중입니다.');
    return;
  }

  // ─── 멀티 프로젝트 ───
  if (cmd.type === 'multi-work') {
    const invalid = cmd.projects.filter(p => !PROJECTS[p]);
    if (invalid.length > 0) {
      await message.reply(`프로젝트 없음: ${invalid.join(', ')}. 등록: ${Object.keys(PROJECTS).join(', ')}`);
      return;
    }
    if (working) { await message.reply('이전 작업 진행 중입니다.'); return; }
    working = true;
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
      working = false;
    }
    return;
  }

  // 프로젝트 검증
  if (!PROJECTS[cmd.project]) {
    await message.reply(`프로젝트 "${cmd.project}" 없음. 등록: ${Object.keys(PROJECTS).join(', ')}`);
    return;
  }

  if (working) { await message.reply('이전 작업 진행 중입니다.'); return; }
  working = true;
  const baseBranch = PROJECTS[cmd.project].branch;

  try {
    const dir = await ensureRepo(cmd.project);

    // ─── !issue ───
    if (cmd.type === 'issue') {
      const [title, ...bodyParts] = cmd.prompt.split('|');
      const body = bodyParts.join('|').trim() || '디스코드에서 생성된 이슈';
      const repoSlug = PROJECTS[cmd.project].repo.replace('https://github.com/', '').replace('.git', '');
      try {
        const issueUrl = await runSpawn('gh', [
          'issue', 'create', '--repo', repoSlug,
          '--title', title.trim(),
          '--body', body,
        ], dir);
        await message.reply(`📌 이슈: ${issueUrl}`);
      } catch (err) {
        await message.reply(`❌ 이슈 생성 실패: ${err.message.slice(0, 500)}`);
      }
      return;
    }

    // ─── !ask ───
    if (cmd.type === 'ask') {
      await message.reply(`🔍 **${cmd.project}** 분석 중...`);
      const result = await runClaude(`다음 질문에 답해줘. 코드를 수정하지 마: ${cmd.prompt}`, dir);
      await sendChunks(message.channel, result);
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
      const result = await runClaude(`리뷰 피드백을 반영해서 코드를 수정해줘: ${cmd.prompt}`, dir);
      const status = await runCmd('git status --porcelain', dir);
      if (status) {
        await runCmd('git add -A', dir);
        const fixCommitMsg = await generateCommitMsg(dir);
        await gitCommit(fixCommitMsg, dir);
        await runCmd(`git push origin ${currentBranch}`, dir);
        await message.channel.send('✅ 수정 푸시 완료');
      }
      await sendChunks(message.channel, result.slice(0, 3800));
      return;
    }

  } catch (err) {
    await message.reply(`❌ 에러: ${err.message.slice(0, 1500)}`);
    try { await runCmd(`git checkout ${baseBranch}`, path.join(WORKSPACE, cmd.project)); } catch {}
  } finally {
    working = false;
  }
});

// ─── 시작 ───
client.once('ready', () => {
  console.log(`Bot ready: ${client.user.tag}`);
  console.log(`Channel: ${process.env.DISCORD_CHANNEL_ID}`);
  console.log(`Projects: ${Object.keys(PROJECTS).join(', ')}`);
});

client.login(process.env.DISCORD_TOKEN);
