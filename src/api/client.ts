export interface User {
  id: string;
  email: string;
  role: 'teacher' | 'admin';
  blocked: boolean;
  mustChangePassword: boolean;
}
export interface Session { user: User; csrfToken: string; expiresAt: string }
export interface ApiProblem {
  code: string;
  message: string;
  requestId?: string;
  details?: { field: string; code: string }[];
}
export class ApiError extends Error {
  constructor(public status: number, public problem: ApiProblem, public retryAfter: string | null = null) {
    super(problem.message);
  }
}

/** One same-origin client; CSRF lives only in memory, never in URLs/storage. */
export class ApiClient {
  csrfToken: string | null = null;
  onUnauthorized = () => {};
  onCSRF = () => {};

  async request<T>(path: string, options: RequestInit = {}, access: 'session' | 'public' | 'login' | 'restore' = 'session'): Promise<T> {
    // Do not allow callers to send credentials to arbitrary URLs.
    if (!/^\/[a-zA-Z0-9/_.?%=&-]*$/.test(path) || path.startsWith('//') || path.includes('..')) {
      throw new Error('Invalid API path');
    }
    const initialToken = this.csrfToken;
    const headers = new Headers(options.headers);
    headers.set('Accept', 'application/json');
    const method = (options.method ?? 'GET').toUpperCase();
    if (options.body && typeof options.body === 'string') headers.set('Content-Type', 'application/json');
    if (access === 'session' && !['GET', 'HEAD', 'OPTIONS'].includes(method) && this.csrfToken) {
      headers.set('X-CSRF-Token', this.csrfToken);
    } else headers.delete('X-CSRF-Token');
    let response: Response;
    try {
      response = await fetch(`/api/v1${path}`, {
        ...options, method, headers, credentials: access === 'public' ? 'omit' : 'same-origin',
        cache: 'no-store', redirect: 'error', signal: options.signal ?? AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ApiError(0, { code: 'network_error', message: 'Нет соединения с сервером. Попробуйте ещё раз.' });
    }
    if (!response.ok) {
      let problem: ApiProblem = { code: 'invalid_response', message: 'Сервер вернул ошибку. Попробуйте ещё раз.' };
      try {
        const data = await response.json();
        if (typeof data?.error?.code === 'string' && typeof data.error.message === 'string') problem = data.error;
      } catch { /* A proxy may return HTML instead of the API envelope. */ }
      if (response.status === 401 && access === 'session' && this.csrfToken === initialToken) {
        this.csrfToken = null;
        this.onUnauthorized();
      }
      if (problem.code === 'csrf_failed' && access === 'session' && this.csrfToken === initialToken) this.onCSRF();
      throw new ApiError(response.status, problem, response.headers.get('Retry-After'));
    }
    if (response.status === 204) return undefined as T;
    try { return await response.json() as T; }
    catch { throw new ApiError(502, { code: 'invalid_response', message: 'Некорректный ответ сервера.' }); }
  }

  async session(path: '/auth/me' | '/auth/login', credentials?: { email: string; password: string }): Promise<Session> {
    const value = await this.request<Session>(path, credentials ? { method: 'POST', body: JSON.stringify(credentials) } : {}, credentials ? 'login' : 'restore');
    const u = value?.user;
    if (!u || typeof u.id !== 'string' || !u.id || typeof u.email !== 'string' ||
      !['teacher', 'admin'].includes(u.role) || u.blocked !== false || typeof u.mustChangePassword !== 'boolean' ||
      typeof value.csrfToken !== 'string' || !value.csrfToken || !Number.isFinite(Date.parse(value.expiresAt))) {
      throw new ApiError(502, { code: 'invalid_response', message: 'Некорректный ответ авторизации.' });
    }
    return value;
  }
}
export const api = new ApiClient();
