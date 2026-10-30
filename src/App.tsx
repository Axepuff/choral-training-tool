import { Message } from './components/ui/Message';
import { Button } from './components/ui/Button';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { ApiError } from './api/client';
import { getAuth, subscribeAuth, restoreSession, login, logout } from './auth/session';
import { ChangePassword } from './auth/ChangePassword';
import { SignIn } from './components/SignIn/SignIn';
import { LiveLibrary } from './components/SongLibrary/LiveLibrary';
import { PublicRoute } from './PublicRoute';
import { readRoute, safeReturn } from './navigation/routes';
import styles from './components/SongLibrary/SongLibrary.module.css';

export function App() {
  const auth = useSyncExternalStore(subscribeAuth, getAuth);
  const [search, setSearch] = useState(window.location.search);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const route = readRoute(search);
  function navigate(query: string) {
    window.history.replaceState(null, '', `${window.location.pathname}${query}`);
    setSearch(query);
  }
  useEffect(() => {
    void restoreSession();
    const sync = () => { setSearch(window.location.search); void restoreSession(); };
    const visible = () => { if (document.visibilityState === 'visible') void restoreSession(); };
    window.addEventListener('popstate', sync);
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);
  useEffect(() => {
    if (!auth.session) return;
    const timeout = window.setTimeout(() => void restoreSession(), Math.max(0, Date.parse(auth.session.expiresAt) - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [auth.session]);
  // Public links are independent of session recovery and always read-only.
  if (route.kind === 'public-list' || route.kind === 'public-song') {
    return <PublicRoute key={`${route.kind}:${route.token}:${'songId' in route ? route.songId : ''}`} token={route.token} songId={route.songId} single={route.kind === 'public-song'} />;
  }
  if (auth.status === 'loading') return <Message tone="muted" role="status">Проверяем сессию…</Message>;
  if (auth.status === 'error' && !auth.session) return <main className={styles.page}><Message tone="error" role="alert">Не удалось проверить сессию. Нет соединения с сервером.</Message>
    <Button onClick={() => void restoreSession()}>Повторить</Button></main>;
  if (!auth.session) {
    const returnTo = route.kind === 'sign-in' ? route.returnTo : safeReturn(search);
    return <SignIn onSignIn={async (credentials) => {
      try {
        await login(credentials);
        navigate(returnTo);
        return 'authenticated';
      } catch (e) {
        if (e instanceof ApiError && e.problem.code === 'invalid_credentials') return 'invalid-credentials';
        throw e;
      }
    }} />;
  }
  if (auth.session.user.mustChangePassword) return <ChangePassword />;
  const user = auth.session.user;
  return <><div className={styles.sessionHeader}>
    <header className={styles.header}>
      <Button disabled={busy} onClick={async () => {
        if ((route.kind === 'create-song' || route.kind === 'edit-song') && !window.confirm('Выйти? Несохранённые изменения будут потеряны.')) return;
        setBusy(true); setError('');
        try { await logout(); navigate('?page=library'); }
        catch (e) { setError(e instanceof ApiError ? e.message : 'Не удалось выйти.'); }
        finally { setBusy(false); }
      }}>{busy ? 'Выходим…' : 'Выйти'}</Button>
    </header>
    <p>{user.email} · {user.role === 'admin' ? 'Администратор' : 'Преподаватель'}</p>
    {error && <Message tone="error" role="alert">{error}</Message>}
    {auth.status === 'error' && <Message tone="error" role="alert">Нет соединения с сервером. Изменения остаются в форме. <Button onClick={() => void restoreSession()}>Повторить проверку сессии</Button></Message>}
  </div><LiveLibrary key={`${user.id}:${route.kind === 'create-song' || route.kind === 'edit-song' ? 'editor' : 'library'}`} user={user} create={route.kind === 'create-song'} editId={route.kind === 'edit-song' ? route.songId : null} /></>;
}
