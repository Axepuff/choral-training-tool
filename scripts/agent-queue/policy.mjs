// Loaded once by the controller, before checking out any candidate branch.
export const repository = 'Axepuff/choral-training-tool';
export const defaultMaxFixRounds = 10;
export function validateFixRoundLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('--max-fix-rounds должен быть положительным безопасным целым числом.');
  }
  return value;
}
export const queue = [
  [2, []], [3, [2]], [4, [3]], [5, [3, 4]], [6, [4, 5]],
  [7, [4, 5]], [8, [7]], [9, [2, 4]], [10, [2, 5, 6, 8, 9]],
  [11, [2, 6, 8]], [31, [10, 11]], [12, [11, 31]], [14, [3]],
  [15, [4, 5, 6, 8, 9, 10, 11, 12, 14]],
].map(([issue, dependencies]) => ({ issue, dependencies }));

export function closesIssue(pr, issue) {
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+(?:#${issue}|https://github\\.com/${repository}/issues/${issue})(?![\\d/])`, 'i').test(pr.body ?? '');
}

export function completed(issue, prs) {
  return issue?.state === 'closed' && issue.state_reason === 'completed'
    && prs.some(pr => pr.merged_at && pr.base.ref === 'main' && closesIssue(pr, issue.number));
}

export function selectTask(issues, prs) {
  for (const task of queue) {
    const issue = issues.find(i => i.number === task.issue);
    if (!issue) throw new Error(`Issue #${task.issue} недоступна.`);
    if (completed(issue, prs)) continue;
    if (issue.state !== 'open') throw new Error(`Issue #${task.issue} закрыта без подтверждённого merge. Проверьте её вручную.`);
    if (!task.dependencies.every(n => completed(issues.find(i => i.number === n), prs))) {
      throw new Error(`Не приняты зависимости Issue #${task.issue}.`);
    }
    const candidates = prs.filter(p => p.state === 'open' && closesIssue(p, task.issue));
    if (candidates.length > 1) throw new Error(`Несколько PR для #${task.issue}; выберите один вручную.`);
    const pr = candidates[0];
    if (pr && (pr.base.ref !== 'main' || pr.head.repo?.full_name !== repository || pr.draft)) {
      throw new Error(`PR #${pr.number} имеет неподдерживаемую ветку, fork или draft.`);
    }
    return { issue, pr };
  }
  return null;
}

export function assertSubscriptionEnvironment(env) {
  const keys = Object.keys(env).filter(k => /(?:API_KEY|ACCESS_TOKEN|BASE_URL|ENDPOINT)$/.test(k)
    && /^(?:OPENAI|CODEX|AZURE_OPENAI|ANTHROPIC|OPENROUTER)_/.test(k) && env[k]);
  if (keys.length) throw new Error(`Уберите API-переменные перед запуском: ${keys.join(', ')}. Очередь использует только вход ChatGPT.`);
}

export function childEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION|COOKIE)/i.test(k)));
}

export function protectedPath(path) {
  return /^(?:scripts\/agent-queue\/|\.codex\/|\.agents\/|AGENTS\.md$|\.git(?:\/|$)|\.github\/workflows\/agent-queue)/.test(path)
    || /(?:^|\/)(?:auth\.json|hosts\.yml|\.env(?:\.(?!example$).*)?|id_rsa|id_ed25519)$/.test(path);
}

export const reviewSchema = {
  type: 'object', additionalProperties: false,
  required: ['head_sha', 'base_sha', 'verdict', 'acceptance_criteria_met', 'summary', 'findings'],
  properties: {
    head_sha: { type: 'string' }, base_sha: { type: 'string' },
    verdict: { type: 'string', enum: ['approve', 'changes_requested'] },
    acceptance_criteria_met: { type: 'boolean' }, summary: { type: 'string' },
    findings: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['severity', 'file', 'line', 'description'],
        properties: {
          severity: { type: 'string', enum: ['P0', 'P1', 'P2'] }, file: { type: 'string' },
          line: { type: 'integer', minimum: 1 }, description: { type: 'string' },
        },
      },
    },
  },
};

export function validateReview(report, head, base) {
  const fail = () => { throw new Error('Некорректное или устаревшее ревью; merge запрещён.'); };
  if (!report || Object.keys(report).sort().join() !== reviewSchema.required.slice().sort().join()
    || report.head_sha !== head || report.base_sha !== base
    || !['approve', 'changes_requested'].includes(report.verdict)
    || typeof report.acceptance_criteria_met !== 'boolean'
    || typeof report.summary !== 'string' || !report.summary.trim() || !Array.isArray(report.findings)) fail();
  for (const finding of report.findings) {
    if (!finding || Object.keys(finding).sort().join() !== 'description,file,line,severity'
      || !['P0', 'P1', 'P2'].includes(finding.severity) || typeof finding.file !== 'string'
      || !Number.isInteger(finding.line) || finding.line < 1
      || typeof finding.description !== 'string' || !finding.description.trim()) fail();
  }
  if (report.verdict === 'approve' && (!report.acceptance_criteria_met || report.findings.length)) fail();
  return report.verdict === 'approve';
}

export function assertChecks(checks) {
  // No checks is a distinct state, allowed only because local checks are mandatory.
  for (const check of checks) {
    if (check.context && check.state === 'success') continue;
    if (check.status === 'completed' && ['success', 'neutral', 'skipped'].includes(check.conclusion)) continue;
    throw new Error('Проверки GitHub ещё выполняются или завершились ошибкой.');
  }
}
