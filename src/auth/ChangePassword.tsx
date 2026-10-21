import { useState } from 'react';
import { changePassword } from './session';
import { ApiError } from '../api/client';
import styles from '../components/SignIn/SignIn.module.css';

export function ChangePassword() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <main className={styles.page}><div className={styles.content}>
    <h1>Смена пароля</h1><p className={styles.intro}>Перед продолжением замените временный пароль. Затем войдите снова.</p>
    <form aria-label="Смена пароля" aria-busy={busy} onSubmit={async (event) => {
      event.preventDefault();
      if (busy) return;
      const form = event.currentTarget;
      const data = new FormData(form);
      setBusy(true); setError('');
      try { await changePassword(String(data.get('currentPassword')), String(data.get('newPassword'))); form.reset(); }
      catch (e) { setError(e instanceof ApiError ? e.message : 'Не удалось сменить пароль.'); }
      finally { setBusy(false); }
    }}>
      <label htmlFor="currentPassword">Текущий пароль</label>
      <input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required readOnly={busy} />
      <label htmlFor="newPassword">Новый пароль (12–128 символов)</label>
      <input id="newPassword" name="newPassword" type="password" autoComplete="new-password" required readOnly={busy} />
      {error && <p className={styles.error} role="alert">{error}</p>}
      <button className={styles.submit} disabled={busy}>{busy ? 'Сохраняем…' : 'Сменить пароль'}</button>
    </form>
  </div></main>;
}
