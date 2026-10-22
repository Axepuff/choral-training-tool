import { api } from './client';
export interface Share { id: string; kind: 'song' | 'list'; ownerId: string; songId: string | null; disabledAt: string | null; createdAt: string }
export interface ShareSecret { share: Share; url: string }
export const listShares = (owner: string) => api.request<{ items: Share[] }>(`/shares?ownerId=${encodeURIComponent(owner)}`);
export const createShare = (body: { kind: 'song'; songId: string } | { kind: 'list'; ownerId: string }, key: string) =>
  api.request<ShareSecret>('/shares', { method: 'POST', body: JSON.stringify(body), headers: { 'Idempotency-Key': key } });
export const rotateShare = (id: string) => api.request<ShareSecret>(`/shares/${id}/rotate`, { method: 'POST' });
export const revokeShare = (id: string) => api.request<void>(`/shares/${id}`, { method: 'DELETE' });
