import { useEffect, useId, useRef, useState } from 'react';
import type { PermanentState, Share, ShareScope, SharingService } from '../../api/shares';
import { ApiError } from '../../api/client';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Message } from '../ui/Message';
import { LibraryIcon } from '../SongLibrary/LibraryIcon';
import styles from './ShareActions.module.css';

export interface ShareTarget {
  scope: ShareScope;
  ownerLabel: string;
  title?: string;
  unavailable?: string | undefined;
  empty?: boolean;
  onEdit?: () => void;
}
export interface ShareActionsProps {
  target: ShareTarget | null;
  service: SharingService;
  kind: 'list' | 'song';
  disabled?: boolean;
  onPreview?: () => void;
}
type Confirmation = { kind: 'rotate' | 'disable'; share: Share; version?: number };

const errorText = (error: unknown) => {
  if (error instanceof ApiError) {
    if (error.status === 412) return 'Ссылка уже изменена. Проверьте её текущее состояние.';
    if (error.status === 403) return 'Нет доступа к этой ссылке. Проверьте выбранного владельца.';
    if (error.status === 404) return 'Песня или ссылка больше недоступна.';
    if (error.status === 503) return 'Сервис ссылок временно недоступен. Попробуйте позже.';
    if (error.problem.code === 'share_disabled') return 'Ссылка отключена. Чтобы снова поделиться, явно создайте новый адрес.';
    if (error.problem.code === 'legacy_transition_required') return 'Есть ранее созданные ссылки. Откройте настройки и создайте постоянную ссылку.';
  }
  return error instanceof Error ? error.message : 'Не удалось получить ссылку. Повторите запрос.';
};

/** The same direct-copy flow and native dialog serve runtime and explicit fixtures. */
export function ShareActions(props: ShareActionsProps) {
  return <ShareActionsContent key={JSON.stringify([props.target?.scope, props.target?.unavailable])} {...props} />;
}

function ShareActionsContent({ target, service, kind, disabled = false, onPreview }: ShareActionsProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [state, setState] = useState<PermanentState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [manual, setManual] = useState(false);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const address = useRef<HTMLInputElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const generation = useRef(0);
  const pending = useRef(false);
  const menuRoot = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const scopeKey = target ? JSON.stringify(target.scope) : '';
  const current = state?.current;
  const url = current?.url ? new URL(current.url, window.location.origin).href : '';
  const activeLegacy = state?.legacy.some(link => !link.disabledAt) ?? false;
  const title = kind === 'list' ? 'Ссылка на репертуар' : 'Ссылка на песню';
  const context = target?.title ?? target?.ownerLabel ?? '';
  const success = kind === 'song' ? `Ссылка на «${target?.title}» скопирована` : 'Ссылка на репертуар скопирована';

  useEffect(() => () => { generation.current++; pending.current = false; }, [scopeKey]);
  useEffect(() => {
    if (!menu) return;
    const closeOutside = (event: PointerEvent) => { if (!menuRoot.current?.contains(event.target as Node)) setMenu(false); };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [menu]);
  useEffect(() => {
    const element = dialog.current;
    if (!open || !element) return;
    const previousOverflow = document.documentElement.style.overflow;
    const previousBodyOverflow = document.body.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    element.showModal();
    heading.current?.focus();
    return () => {
      element.close();
      document.documentElement.style.overflow = previousOverflow;
      document.body.style.overflow = previousBodyOverflow;
      returnFocus.current?.focus({ preventScroll: true });
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    if (confirm) cancel.current?.focus();
    else if (manual && url) { address.current?.focus(); address.current?.select(); }
    else heading.current?.focus();
  }, [open, confirm, manual, url]);

  function show() {
    setMenu(false); setOpen(true);
  }
  function close() {
    generation.current++; pending.current = false;
    setOpen(false); setBusy(false); setConfirm(null); setManual(false); setError('');
  }
  function start() {
    if (pending.current || !target || disabled) return null;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    const ticket = ++generation.current;
    return { ticket, target };
  }
  const valid = (ticket: number) => generation.current === ticket;
  function finish(ticket: number) { if (valid(ticket)) { pending.current = false; setBusy(false); } }

  async function copy(urlToCopy: string, ticket: number) {
    // Scope/unmount/close can change while awaiting the server; never touch the
    // clipboard for an obsolete operation, even if its state update is ignored.
    if (!valid(ticket)) return;
    try {
      await navigator.clipboard.writeText(new URL(urlToCopy, window.location.origin).href);
      if (valid(ticket)) { setNotice(success); setManual(false); }
    } catch {
      if (valid(ticket)) { show(); setManual(true); setError('Не удалось скопировать автоматически. Нажмите «Копировать» или выделите адрес.'); }
    }
  }
  async function load(copyAfter: boolean) {
    if (!open) returnFocus.current = !copyAfter ? menuTrigger.current : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const operation = start();
    if (!operation) return;
    const { ticket, target: selected } = operation;
    if (!copyAfter || selected.unavailable) show();
    try {
      let next = await service.get(selected.scope);
      if (!valid(ticket)) return;
      setState(next);
      if (selected.unavailable) return;
      if (copyAfter && !next.current && !next.legacy.some(link => !link.disabledAt)) {
        next = await service.ensure(selected.scope);
        if (!valid(ticket)) return;
        setState(next);
      }
      if (copyAfter && next.current?.url) await copy(next.current.url, ticket);
      else if (copyAfter) show();
    } catch (failure) {
      if (valid(ticket)) { setState(null); setError(errorText(failure)); show(); }
    } finally { finish(ticket); }
  }
  async function create() {
    const operation = start();
    if (!operation) return;
    const { ticket, target: selected } = operation;
    try {
      const next = await service.ensure(selected.scope, activeLegacy);
      if (!valid(ticket)) return;
      setState(next);
      if (next.current?.url) await copy(next.current.url, ticket);
    } catch (failure) { if (valid(ticket)) { setError(errorText(failure)); await reconcile(selected.scope, ticket); } }
    finally { finish(ticket); }
  }
  async function reconcile(scope: ShareScope, ticket: number) {
    try { const next = await service.get(scope); if (valid(ticket)) setState(next); return true; }
    catch { if (valid(ticket)) setState(null); return false; }
  }
  async function mutate(action: Confirmation) {
    const operation = start();
    if (!operation) return;
    const { ticket, target: selected } = operation;
    try {
      if (action.kind === 'rotate' && action.version !== undefined) await service.rotate(action.share.id, action.version);
      else await service.revoke(action.share.id, action.version);
      const next = await service.get(selected.scope);
      if (!valid(ticket)) return;
      setState(next); setConfirm(null);
      setNotice(action.kind === 'rotate' ? 'Адрес заменён. Передайте ученикам новую ссылку.' : 'Ссылка отключена.');
    } catch (failure) {
      if (valid(ticket)) {
        const refreshed = await reconcile(selected.scope, ticket);
        // Keeping the old confirmation would retain its stale revision.
        if (valid(ticket)) {
          setError(`${errorText(failure)} ${refreshed ? 'Состояние перечитано; проверьте его перед новым действием.' : 'Не удалось проверить текущее состояние. Повторите загрузку.'}`);
          setConfirm(null);
        }
      }
    } finally { finish(ticket); }
  }
  function confirmAction(action: Confirmation) { setError(''); setNotice(''); setConfirm(action); }

  return <div className={`${styles.root} ${kind === 'list' ? styles.repertoire : styles.song}`}>
    <div className={styles.controls}>
      <Button variant={kind === 'list' ? 'primary' : 'neutral'} size={kind === 'list' ? 'small' : 'icon'} disabled={!target || disabled || busy}
        aria-busy={busy} aria-label={kind === 'song' ? `Скопировать ссылку: ${target?.title ?? 'песня'}` : undefined}
        title={kind === 'song' ? 'Скопировать ссылку на песню' : undefined} onClick={() => void load(true)}>
        {busy ? <Message as="span" variant="spinner" aria-hidden="true" /> : <LibraryIcon name="link" />}
        {kind === 'list' && <span>{busy ? 'Получаем ссылку…' : 'Копировать ссылку для учеников'}</span>}
      </Button>
      <div className={styles.menuRoot} ref={menuRoot} onKeyDown={event => { if (event.key === 'Escape') { setMenu(false); menuTrigger.current?.focus(); } }}>
        <Button ref={menuTrigger} size="icon" disabled={!target || disabled || busy} aria-label={`Действия со ссылкой: ${context || 'репертуар'}`} aria-expanded={menu}
          aria-controls={`${id}-menu`} onClick={() => setMenu(value => !value)}>⋯</Button>
        {menu && <div id={`${id}-menu`} className={styles.menu}>
          <Button variant="text" size="small" onClick={() => void load(false)}>Настройки ссылки</Button>
        </div>}
      </div>
    </div>
    {!open && notice && <Message className={styles.feedback} tone="info" size="small" role="status">{notice}</Message>}
    {open && <dialog ref={dialog} className={styles.dialog} aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); close(); }}
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], summary')].filter(element => element.getClientRects().length > 0);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === heading.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <header className={styles.header}>
        <h2 ref={heading} tabIndex={-1} id={`${id}-title`}>{confirm ? confirm.kind === 'rotate' ? 'Заменить адрес?' : 'Отключить ссылку?' : title}</h2>
        <Button size="icon" aria-label="Закрыть настройки ссылки" onClick={close}>×</Button>
      </header>
      <div className={styles.context}>{target?.title && <strong>{target.title}</strong>}<span>{target?.ownerLabel}</span></div>
      {busy && <Message role="status" size="small">Получаем данные…</Message>}
      {error && <Message tone="error" variant="banner" role="alert">{error}</Message>}
      {notice && <Message tone="info" variant="banner" role="status">{notice}</Message>}
      {confirm ? <div className={styles.body}>
        <p>{confirm.kind === 'rotate' ? 'Старый адрес перестанет работать у всех, кому его отправляли. Ученикам потребуется передать новый. Публикация песен не изменится.' : 'Этот адрес перестанет открываться у всех, кому его отправляли. Публикация песен не изменится.'}</p>
        {confirm.version === undefined && <p>Ссылка от {new Date(confirm.share.createdAt).toLocaleString('ru')}.</p>}
        <p className={styles.help}>{kind === 'song' ? 'Песня останется доступна через ссылку на репертуар. Чтобы закрыть весь публичный доступ к песне, снимите её с публикации.' : 'Отдельные ссылки на песни продолжат работать.'} Другие ранее созданные адреса не изменятся.</p>
        <div className={styles.confirmButtons}><Button variant="danger" disabled={busy} onClick={() => void mutate(confirm)}>{confirm.kind === 'rotate' ? 'Заменить адрес' : 'Отключить ссылку'}</Button><Button ref={cancel} disabled={busy} onClick={() => { setConfirm(null); setError(''); }}>Отмена</Button></div>
      </div> : <div className={styles.body}>
        {target?.unavailable && <Message tone="info" variant="banner"><strong>Песня пока недоступна ученикам.</strong> {target.unavailable}{target.onEdit && <Button variant="text" size="small" onClick={() => { close(); target.onEdit?.(); }}>Открыть редактор</Button>}</Message>}
        {!target?.unavailable && <p>{kind === 'song' ? 'По этой ссылке доступна только эта песня.' : target?.empty ? 'Пока нет опубликованных песен. Они появятся здесь после публикации.' : 'Доступны все опубликованные песни. Новые появятся по этой же ссылке.'}</p>}
        {!state && !busy && <Button onClick={() => void load(false)}>Повторить</Button>}
        {state && !current && <>
          <p>{activeLegacy ? 'Старые действующие ссылки продолжат работать. Создайте постоянную ссылку, которую можно будет копировать здесь в любое время.' : 'Ссылка ещё не создана.'}</p>
          <Button variant="primary" disabled={busy || !!target?.unavailable} onClick={() => void create()}>{activeLegacy ? 'Создать постоянную ссылку' : 'Создать и скопировать'}</Button>
        </>}
        {current?.share.disabledAt && <><p className={styles.state}>Ссылка отключена</p><p>Прежний адрес останется недействительным. Чтобы снова поделиться, создайте новый.</p><Button variant="primary" disabled={busy || !!target?.unavailable} onClick={() => void mutate({ kind: 'rotate', share: current.share, version: current.version })}>Создать новый адрес</Button></>}
        {url && <>
          <label className={styles.field} htmlFor={`${id}-url`}>Адрес для учеников<Input ref={address} id={`${id}-url`} name="shareUrl" readOnly value={url} onFocus={event => event.target.select()} /></label>
          <Button variant="primary" disabled={busy || !!target?.unavailable} onClick={() => { const operation = start(); if (operation) void copy(url, operation.ticket).finally(() => finish(operation.ticket)); }}>Копировать</Button>
          {!target?.unavailable && (onPreview ? <Button variant="text" size="small" onClick={() => { close(); onPreview(); }}>Посмотреть как ученик</Button> : <a href={url} target="_blank" rel="noreferrer">Посмотреть как ученик</a>)}
        </>}
        <p className={styles.help}>Слушать может любой, у кого есть ссылка. Вход не нужен.</p>
        {current && !current.share.disabledAt && <div className={styles.settings}>
          <Button variant="text" size="small" disabled={busy} onClick={() => confirmAction({ kind: 'rotate', share: current.share, version: current.version })}>Заменить адрес</Button>
          <Button variant="dangerText" size="small" disabled={busy} onClick={() => confirmAction({ kind: 'disable', share: current.share, version: current.version })}>Отключить ссылку</Button>
        </div>}
        {!!state?.legacy.length && <details className={styles.legacy}><summary>Ранее созданные ссылки — {state.legacy.length}</summary>
          {state.legacy.map(link => <div key={link.id} className={styles.legacyRow}><div><time>{new Date(link.createdAt).toLocaleString('ru')}</time><span>{link.disabledAt ? 'Отключена' : 'Действует'}</span></div>{!link.disabledAt && <Button variant="dangerText" size="small" disabled={busy} onClick={() => confirmAction({ kind: 'disable', share: link })}>Отключить</Button>}</div>)}
        </details>}
      </div>}
    </dialog>}
  </div>;
}
