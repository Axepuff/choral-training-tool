import type { PermanentState, Share, ShareScope, SharingService } from '../../api/shares';
import { ApiError } from '../../api/client';

export type SharingScenario = 'ready' | 'first' | 'disabled' | 'legacy' | 'error';
/** Explicit in-memory Storybook data. Never imported by runtime components. */
export function sharingFixture(scenario: SharingScenario = 'ready'): SharingService {
  const scopes = new Map<string, PermanentState>();
  let sequence = 0;
  const key = (scope: ShareScope) => JSON.stringify(scope);
  function record(scope: ShareScope): Share {
    return { id: `fixture-${++sequence}`, kind: scope.kind, ownerId: scope.kind === 'list' ? scope.ownerId : 'elena@example.invalid', songId: scope.kind === 'song' ? scope.songId : null, createdAt: '2026-10-29T14:48:32Z', disabledAt: null };
  }
  function newCurrent(scope: ShareScope) {
    const share = record(scope);
    return { share, version: 1, url: `https://example.invalid/?${scope.kind}=${share.id}` };
  }
  function read(scope: ShareScope): PermanentState {
    if (scenario === 'error') throw new ApiError(503, { code: 'unavailable', message: 'Сервис временно недоступен.' });
    if (!scopes.has(key(scope))) {
      const current = ['first', 'legacy'].includes(scenario) ? null : newCurrent(scope);
      if (current && scenario === 'disabled') { current.share.disabledAt = '2026-10-30T14:00:00Z'; current.url = ''; }
      scopes.set(key(scope), { current, legacy: scenario === 'legacy' ? [record(scope), { ...record(scope), disabledAt: '2026-10-30T14:00:00Z' }] : [] });
    }
    return scopes.get(key(scope))!;
  }
  function locate(id: string, version?: number) {
    for (const state of scopes.values()) {
      if (state.current?.share.id === id) {
        if (version !== state.current.version) throw new ApiError(412, { code: 'precondition_failed', message: 'Ссылка уже изменена.' });
        return { state, share: state.current.share };
      }
      const share = state.legacy.find(link => link.id === id);
      if (share) return { state, share };
    }
    throw new Error('Ссылка недоступна.');
  }
  return {
    async get(scope) { return structuredClone(read(scope)); },
    async ensure(scope, acceptLegacy) {
      const state = read(scope);
      if (state.current?.share.disabledAt) throw new ApiError(409, { code: 'share_disabled', message: 'Ссылка отключена.' });
      if (!state.current && state.legacy.some(link => !link.disabledAt) && !acceptLegacy) throw new Error('Создайте постоянную ссылку явно.');
      state.current ??= newCurrent(scope);
      return structuredClone(state);
    },
    async rotate(id, version) {
      const { state } = locate(id, version);
      if (!state.current) throw new Error('Ссылка недоступна.');
      state.current.version++;
      state.current.share.disabledAt = null;
      state.current.url = `https://example.invalid/?${state.current.share.kind}=${id}-v${state.current.version}`;
    },
    async revoke(id, version) {
      const { state, share } = locate(id, version);
      share.disabledAt = '2026-11-07T12:00:00Z';
      if (state.current?.share.id === id) { state.current.version++; state.current.url = null; }
    },
  };
}
