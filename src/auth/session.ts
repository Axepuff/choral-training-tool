import { ApiError, api } from '../api/client';
import type { Session } from '../api/client';

export type AuthState = { status: 'loading' | 'ready' | 'error'; session: Session | null };
let state: AuthState = { status: 'loading', session: null };
let generation = 0;
const listeners = new Set<() => void>();
function publish(next: AuthState) {
  state = next;
  api.csrfToken = next.session?.csrfToken ?? null;
  listeners.forEach((listener) => listener());
}
export const getAuth = () => state;
export function subscribeAuth(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function clearSession() {
  generation++;
  publish({ status: 'ready', session: null });
}
api.onUnauthorized = clearSession;
api.onCSRF = () => { void restoreSession(); };

export async function restoreSession() {
  const current = ++generation;
  // Hide editor actions until the server confirms the current identity.
  publish({ status: 'loading', session: null });
  try {
    const session = await api.session('/auth/me');
    if (current === generation) publish({ status: 'ready', session });
  } catch (error) {
    if (current === generation) publish({ status: error instanceof ApiError && error.status === 401 ? 'ready' : 'error', session: null });
  }
}
export async function login(credentials: { email: string; password: string }) {
  const current = ++generation;
  const session = await api.session('/auth/login', credentials);
  if (current !== generation) throw new Error('Session changed during login');
  publish({ status: 'ready', session });
}
export async function logout() {
  // The UI must not claim logout succeeded if the server did not revoke it.
  await api.request<void>('/auth/logout', { method: 'POST' });
  clearSession();
}
export async function changePassword(currentPassword: string, newPassword: string) {
  await api.request<void>('/auth/password', { method: 'PUT', body: JSON.stringify({ currentPassword, newPassword }) });
  clearSession();
}
