import { defaultMaxFixRounds, validateFixRoundLimit, validateReview } from './policy.mjs';

// Each review is a fresh Codex process. No approval survives a restart or a new SHA.
export async function processTask(io, task, state) {
  const maxFixRounds = validateFixRoundLimit(io.maxFixRounds ?? defaultMaxFixRounds);
  await io.prepare(task, state);
  if (!state.implemented) {
    await io.implement(task, null);
    await io.commit(task);
    state.implemented = true;
    await io.save(state);
  }
  for (;;) {
    await io.guard();
    const revision = await io.revision();
    let checks;
    try { checks = await io.check(); }
    catch (error) {
      if (!error.checkFailure) throw error;
      await fix({ checks_failed: error.message });
      continue;
    }
    await io.guard();
    await io.assertStable(revision, false);
    await io.publish(task, state, checks);
    await io.save(state);
    const report = await io.review(task, revision, checks);
    const approved = validateReview(report, revision.head, revision.base);
    await io.assertStable(revision, true);
    await io.recordReview(state, report, checks);
    if (report.verdict === 'manual_check_required') {
      throw new Error(`Нужна ручная проверка. Раунд исправлений не потрачен; PR сохранён.\n${report.summary}\nЗафиксируйте результат или согласованную отсрочку в документации PR, затем повторите запуск.`);
    }
    if (!approved) { await fix(report); continue; }
    await io.remoteChecks(state);
    await io.assertStable(revision, true);
    await io.merge(state, revision);
    return;
  }

  async function fix(feedback) {
    if (state.fixRounds >= maxFixRounds) {
      throw new Error(`Лимит исправлений исчерпан (${state.fixRounds}/${maxFixRounds}). Очередь остановлена; PR сохранён. Для дополнительных попыток увеличьте --max-fix-rounds.`);
    }
    // Charge the attempt before starting it, including interrupted/failed executions.
    state.fixRounds += 1;
    await io.save(state);
    await io.implement(task, feedback);
    await io.commit(task);
  }
}
