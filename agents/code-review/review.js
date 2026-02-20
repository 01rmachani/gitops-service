#!/usr/bin/env node
/**
 * Code Review Agent
 *
 * Fetches a PR diff from GitHub, sends it to an LLM via OpenRouter,
 * parses the structured JSON review, and posts it as a PR comment.
 *
 * Usage (called from GitHub Actions):
 *   node review.js
 *
 * Required env vars:
 *   GH_TOKEN            - GitHub token (read PR diff, write comments)
 *   OPENROUTER_API_KEY  - OpenRouter API key
 *   GH_REPO_FULL        - e.g. "owner/repo"
 *   PR_NUMBER           - Pull request number
 *   REVIEW_MODEL        - Optional model override (default: anthropic/claude-3.5-haiku)
 *   GITHUB_OUTPUT       - Path to GitHub Actions output file (set by runner)
 */

const fs = require('fs');
const path = require('path');

const {
  GH_TOKEN,
  OPENROUTER_API_KEY,
  GH_REPO_FULL,
  PR_NUMBER,
  REVIEW_MODEL = 'anthropic/claude-3.5-haiku',
  GITHUB_OUTPUT,
} = process.env;

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GH_API = 'https://api.github.com';
const MAX_DIFF_CHARS = 24000;
const GH_TIMEOUT_MS = parseInt(process.env.GH_API_TIMEOUT_MS || '30000', 10);
const LLM_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '120000', 10);

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function ghHeaders() {
  return {
    Authorization: `Bearer ${GH_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

async function fetchDiff() {
  const { signal, clear } = withTimeout(GH_TIMEOUT_MS);
  try {
    const res = await fetch(`${GH_API}/repos/${GH_REPO_FULL}/pulls/${PR_NUMBER}`, {
      headers: { ...ghHeaders(), Accept: 'application/vnd.github.v3.diff' },
      signal,
    });
    if (!res.ok) throw new Error(`Failed to fetch PR diff: ${res.status} ${await res.text()}`);
    return res.text();
  } finally {
    clear();
  }
}

async function fetchPrMeta() {
  const { signal, clear } = withTimeout(GH_TIMEOUT_MS);
  try {
    const res = await fetch(`${GH_API}/repos/${GH_REPO_FULL}/pulls/${PR_NUMBER}`, {
      headers: ghHeaders(),
      signal,
    });
    if (!res.ok) throw new Error(`Failed to fetch PR meta: ${res.status}`);
    return res.json();
  } finally {
    clear();
  }
}

async function callLlm(systemPrompt, diff) {
  let truncated = diff;
  let truncationNote = '';
  if (diff.length > MAX_DIFF_CHARS) {
    truncated = diff.slice(0, MAX_DIFF_CHARS);
    truncationNote = `\n\n[Diff truncated at ${MAX_DIFF_CHARS} chars — ${diff.length - MAX_DIFF_CHARS} chars omitted]`;
  }

  const userMessage = truncated.trim()
    ? `Please review the following pull request diff:\n\n\`\`\`diff\n${truncated}${truncationNote}\n\`\`\``
    : 'The diff is empty — no code changes detected.';

  const { signal, clear } = withTimeout(LLM_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': `https://github.com/${GH_REPO_FULL}`,
        'X-Title': 'gitops-service code-review-agent',
      },
      body: JSON.stringify({
        model: REVIEW_MODEL,
        max_tokens: 2048,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
      signal,
    });
  } finally {
    clear();
  }

  if (!res.ok) throw new Error(`OpenRouter error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

function parseReview(raw) {
  // Strip markdown fences if model wrapped output anyway
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Fallback: extract first {...} block
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Could not parse LLM response as JSON: ${raw.slice(0, 200)}`);
  }
}

function formatComment(review, prMeta) {
  const outcomeEmoji = {
    APPROVE: '✅',
    REQUEST_CHANGES: '❌',
    COMMENT: '💬',
  }[review.outcome] || '💬';

  const severityEmoji = { critical: '🔴', major: '🟠', minor: '🟡', info: 'ℹ️' };

  const issueLines = (review.issues || []).map(issue => {
    const emoji = severityEmoji[issue.severity] || '•';
    const loc = issue.file ? (issue.line ? `\`${issue.file}:${issue.line}\`` : `\`${issue.file}\``) : '';
    return `- ${emoji} **${issue.severity}**${loc ? ` ${loc}` : ''}: ${issue.message}`;
  });

  return [
    `## ${outcomeEmoji} Code Review — ${review.outcome}`,
    '',
    review.summary,
    '',
    issueLines.length ? '### Issues\n' + issueLines.join('\n') : '_No issues found._',
    '',
    `---`,
    `_Reviewed by [gitops code-review agent](https://github.com/${GH_REPO_FULL}) · model: \`${REVIEW_MODEL}\`_`,
  ].join('\n');
}

async function postComment(body) {
  const res = await fetch(`${GH_API}/repos/${GH_REPO_FULL}/issues/${PR_NUMBER}/comments`, {
    method: 'POST',
    headers: ghHeaders(),
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`Failed to post comment: ${res.status} ${await res.text()}`);
  return res.json();
}

function setOutput(key, value) {
  if (GITHUB_OUTPUT) {
    fs.appendFileSync(GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

async function main() {
  if (!GH_TOKEN) throw new Error('GH_TOKEN is required');
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required');
  if (!GH_REPO_FULL) throw new Error('GH_REPO_FULL is required');
  if (!PR_NUMBER) throw new Error('PR_NUMBER is required');

  console.log(`Reviewing PR #${PR_NUMBER} in ${GH_REPO_FULL} with model ${REVIEW_MODEL}`);

  const systemPrompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');
  const [diff, prMeta] = await Promise.all([fetchDiff(), fetchPrMeta()]);

  console.log(`Diff size: ${diff.length} chars`);

  const raw = await callLlm(systemPrompt, diff);
  console.log('LLM raw response:', raw.slice(0, 300));

  const review = parseReview(raw);
  console.log(`Review outcome: ${review.outcome}, issues: ${(review.issues || []).length}`);

  const comment = formatComment(review, prMeta);
  await postComment(comment);
  console.log('Review comment posted.');

  // Emit outcome for use in subsequent workflow steps
  setOutput('review_outcome', review.outcome);
}

main().catch(err => {
  console.error('Code review agent failed:', err.message);
  // Emit COMMENT as safe fallback so the workflow can decide what to do
  setOutput('review_outcome', 'COMMENT');
  process.exit(1);
});
