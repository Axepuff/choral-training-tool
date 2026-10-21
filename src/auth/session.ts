import { ApiError, api } from '../api/client';
import type { Session } from '../api/client';

export type AuthState = { status: 'loading' | 'checking' | 'ready' | 'error'; session: Session | null };
let state: AuthState = { status: 'loading', session: null };
let generation = 0;
let authOperations = 0;
let restoring = false;
let refreshAfterOperation = false;
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
api.onCSRF = () => {
  if (authOperations) refreshAfterOperation = true;
  else void restoreSession();
};

export async function restoreSession() {
  if (authOperations || restoring) return;
  restoring = true;
  const current = generation;
  const previous = state;
  // Keep forms mounted while hiding editor actions during background checks.
  publish({ ...state, status: state.status === 'loading' ? 'loading' : 'checking' });
  try {
    const session = await api.session('/auth/me');
    if (current === generation) publish({ status: 'ready', session });
  } catch (error) {
    if (current === generation) {
      const unauthorized = error instanceof ApiError && error.status === 401;
      publish(unauthorized ? { status: 'ready', session: null }
        : previous.status === 'ready' && (!previous.session || previous.session.user.mustChangePassword)
          ? previous : { status: 'error', session: null });
    }
  } finally {
    restoring = false;
  }
}
// Auth writes supersede any pending me and cannot be interrupted by focus checks.
async function authOperation<T>(action: () => Promise<T>) {
  generation++;
  if (state.status === 'checking') publish({ ...state, status: 'ready' });
  authOperations++;
  try { return await action(); }
  finally {
    authOperations--;
    if (!authOperations && refreshAfterOperation) {
      refreshAfterOperation = false;
      void restoreSession();
    }
  }
}
export async function login(credentials: { email: string; password: string }) {
  return authOperation(async () => {
    const current = generation;
    const session = await api.session('/auth/login', credentials);
    if (current !== generation) throw new Error('Session changed during login');
    publish({ status: 'ready', session });
  });
}
export async function logout() {
  return authOperation(async () => {
    // The UI must not claim logout succeeded if the server did not revoke it.
    await api.request<void>('/auth/logout', { method: 'POST' });
    clearSession();
  });
}
export async function changePassword(currentPassword: string, newPassword: string) {
  return authOperation(async () => {
    await api.request<void>('/auth/password', { method: 'PUT', body: JSON.stringify({ currentPassword, newPassword }) });
    clearSession();
  });
}
