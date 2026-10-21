export type Route =
  | { kind: 'public-list' | 'public-song'; token: string; songId: string | null }
  | { kind: 'sign-in'; returnTo: string }
  | { kind: 'library' | 'create-song' | 'edit-song'; songId: string | null };

// Reconstruct a small allowlist rather than trusting an arbitrary redirect URL.
export function safeReturn(value: string | null): string {
  if (!value || !value.startsWith('?') || value.length > 500) return '?page=library';
  const p = new URLSearchParams(value);
  const page = p.get('page');
  if (page === 'library' || page === 'create-song') return `?page=${page}`;
  if (page === 'edit-song' && /^[a-f0-9-]{36}$/.test(p.get('id') ?? '')) return `?page=edit-song&id=${p.get('id')}`;
  return '?page=library';
}
export function readRoute(search: string): Route {
  const p = new URLSearchParams(search);
  // Public scope always wins over page/role/owner query parameters.
  if (p.has('list')) return { kind: 'public-list', token: p.get('list') ?? '', songId: p.get('id') };
  if (p.has('song')) return { kind: 'public-song', token: p.get('song') ?? '', songId: null };
  if (p.get('page') === 'sign-in') return { kind: 'sign-in', returnTo: safeReturn(p.get('returnTo')) };
  if (p.get('page') === 'create-song' || p.get('page') === 'edit-song') {
    return { kind: p.get('page') as 'create-song' | 'edit-song', songId: p.get('id') };
  }
  return { kind: 'library', songId: null };
}
