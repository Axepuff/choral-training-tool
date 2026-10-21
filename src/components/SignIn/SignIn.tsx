import { useId, useState } from 'react';
import styles from './SignIn.module.css';

export interface SignInCredentials { email: string; password: string }
export type SignInResult = 'authenticated' | 'invalid-credentials';
export interface SignInProps {
  /** Адаптер реального входа; stories передают явные fixtures. */
  onSignIn?: (credentials: SignInCredentials) => Promise<SignInResult>;
  /** Email для демонстрационных состояний. Пароль не задаётся через props. */
  initialEmail?: string;
}

/** Один экран входа для преподавателя и администратора; роль определяет сервер. */
export function SignIn({ onSignIn, initialEmail = '' }: SignInProps) {
  const id = useId();
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<'idle' | 'pending' | 'invalid' | 'unavailable' | 'demo' | 'success'>('idle');
  const busy = state === 'pending';
  const error = state === 'invalid' || state === 'unavailable';

  function clearFeedback() {
    if (!busy) setState('idle');
  }

  return <main className={styles.page}>
    <div className={styles.content}>
      <h1>Вход</h1>
      <p className={styles.intro}>Для преподавателей и администратора хора.</p>
      <form aria-label="Вход в аккаунт" aria-busy={busy} onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        if (!onSignIn) { setState('demo'); return; }
        setState('pending');
        try {
          const result = await onSignIn({ email: email.trim(), password });
          setState(result === 'authenticated' ? 'success' : 'invalid');
          if (result === 'authenticated') setPassword('');
        } catch {
          setState('unavailable');
        }
      }}>
        <label htmlFor={`${id}-email`}>Email</label>
        <input id={`${id}-email`} name="email" type="email" inputMode="email" autoComplete="username"
          autoCapitalize="none" spellCheck={false} required maxLength={254} readOnly={busy}
          placeholder="name@example.com" value={email}
          aria-describedby={error ? `${id}-feedback` : undefined}
          onChange={(event) => { setEmail(event.target.value); clearFeedback(); }} />
        <label htmlFor={`${id}-password`}>Пароль</label>
        <div className={styles.password}>
          <input id={`${id}-password`} name="password" type={visible ? 'text' : 'password'} autoComplete="current-password"
            required readOnly={busy} value={password}
            aria-describedby={error ? `${id}-feedback` : undefined}
            onChange={(event) => { setPassword(event.target.value); clearFeedback(); }} />
          <button className={styles.visibility} type="button" aria-label="Показать пароль" aria-pressed={visible}
            title={visible ? 'Скрыть пароль' : 'Показать пароль'} aria-controls={`${id}-password`}
            onClick={() => setVisible(!visible)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" />
              {visible && <path d="m3 3 18 18" />}
            </svg>
          </button>
        </div>
        {error && <p className={styles.error} id={`${id}-feedback`} role="alert">
          {state === 'invalid' ? 'Неверный email или пароль. Проверьте данные и попробуйте ещё раз.' : 'Не удалось войти. Попробуйте ещё раз позже.'}
        </p>}
        <button className={styles.submit} type="submit" disabled={busy}>{busy ? 'Входим…' : 'Войти'}</button>
        <div aria-live="polite" aria-atomic="true">
          {busy && <p className={styles.status} role="status">Проверяем данные…</p>}
          {state === 'demo' && <p className={styles.status} role="status">Это макет: данные не отправлены, вход пока не подключён.</p>}
          {state === 'success' && <p className={styles.status} role="status">Вход выполнен.</p>}
        </div>
      </form>
      <p className={styles.help}>Забыли пароль или нужен аккаунт? Обратитесь к администратору хора.</p>
      <p className={styles.guest}>Чтобы слушать партии, вход не нужен. Откройте ссылку на песню от преподавателя.</p>
    </div>
  </main>;
}
