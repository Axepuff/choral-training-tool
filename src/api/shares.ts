import { api } from './client';
import type { User } from './client';
export interface Share { id: string; kind: 'song' | 'list'; ownerId: string; songId: string | null; disabledAt: string | null; createdAt: string }

export type ShareScope = { kind: 'song'; songId: string } | { kind: 'list'; ownerId: string };
export interface PermanentState {
  current: { share: Share; version: number; url: string | null } | null;
  legacy: Share[];
}
/** Runtime and explicit Storybook fixtures share the same UI-facing operations. */
export interface SharingService {
  get(scope: ShareScope): Promise<PermanentState>;
  ensure(scope: ShareScope, acceptLegacy?: boolean): Promise<PermanentState>;
  rotate(id: string, version: number): Promise<void>;
  revoke(id: string, version?: number): Promise<void>;
}
const scopeQuery = (scope: ShareScope) => new URLSearchParams(scope).toString();
export const sharingService: SharingService = {
  get: scope => api.request(`/shares/permanent?${scopeQuery(scope)}`),
  ensure: (scope, acceptLegacy = false) => api.request('/shares/permanent', { method: 'POST', body: JSON.stringify({ ...scope, acceptLegacy }) }),
  rotate: async (id, version) => { await api.request(`/shares/${id}/rotate`, { method: 'POST', headers: { 'If-Match': `"${version}"` } }); },
  revoke: (id, version) => api.request(`/shares/${id}`, { method: 'DELETE', ...(version === undefined ? {} : { headers: { 'If-Match': `"${version}"` } }) }),
};
export async function listShareOwners(signal?: AbortSignal): Promise<User[]> {
  const items: User[] = [];
  let cursor: string | null = null;
  do {
    const page: { items: User[]; nextCursor: string | null } = await api.request(`/admin/users?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, signal ? { signal } : {});
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}
