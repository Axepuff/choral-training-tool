import { Message } from '../../components/ui/Message';
import { Checkbox } from '../../components/ui/Checkbox';
import { Select } from '../../components/ui/Select';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { useId, useState } from 'react';
import { CreateSong } from '../../components/CreateSong/CreateSong';
import type { SongFormValue } from '../../components/CreateSong/CreateSong';
import { LibraryIcon } from '../../components/SongLibrary/LibraryIcon';
import { RehearsalPlayer } from '../../components/RehearsalPlayer/RehearsalPlayer';
import styles from './WorkflowPrototype.module.css';

type SongState = 'published' | 'draft' | 'processing';
interface Piece { id: string; title: string; state: SongState; parts: number; bpm: number; form?: SongFormValue }
interface Account { email: string; role: 'admin' | 'teacher'; blocked: boolean; temporary: boolean }
type Screen = 'songs' | 'share' | 'guest' | 'player' | 'editor' | 'accounts' | 'account';
type Scenario = 'ready' | 'empty' | 'loading' | 'error';
export interface WorkflowPrototypeProps {
  role?: 'teacher' | 'admin';
  initialScreen?: 'songs' | 'share' | 'accounts';
  scenario?: Scenario;
}
const initialPieces: Piece[] = [
  { id: 'evening', title: 'Тихий вечер', state: 'published', parts: 5, bpm: 84 },
  { id: 'road', title: 'Дорога домой', state: 'published', parts: 4, bpm: 96 },
  { id: 'morning', title: 'Утро', state: 'draft', parts: 5, bpm: 72 },
  { id: 'spring', title: 'Весенняя песня', state: 'processing', parts: 4, bpm: 108 },
];
const initialAccounts: Account[] = [
  { email: 'admin@example.invalid', role: 'admin', blocked: false, temporary: false },
  { email: 'elena@example.invalid', role: 'teacher', blocked: false, temporary: false },
  { email: 'mikhail@example.invalid', role: 'teacher', blocked: false, temporary: true },
  { email: 'anna@example.invalid', role: 'teacher', blocked: true, temporary: false },
];
const stateLabel = { published: 'Опубликована', draft: 'Черновик', processing: 'Обрабатывается аудио' };
const defaultForm = (piece: Piece): SongFormValue => piece.form ?? ({
  title: piece.title, bpm: piece.bpm, beatsPerBar: 4, beatUnit: 4, notes: '',
  tracks: ['Сопрано', 'Альт', 'Тенор', 'Бас', 'Минус'].slice(0, piece.parts).map((name, i) => ({
    id: `fixture-${i}`, name, ...(piece.state !== 'processing' ? { existingFileName: `${name}.m4a` } : {}),
  })),
});

const readyToPublish = (piece: Piece) => piece.state !== 'processing' && defaultForm(piece).tracks.every(t => !!t.existingFileName && !t.file);

/** Interactive design fixture. Imported only by stories; never a runtime API fallback. */
export function WorkflowPrototype({ role = 'teacher', initialScreen = 'songs', scenario = 'ready' }: WorkflowPrototypeProps) {
  const id = useId();
  const [screen, setScreen] = useState<Screen>(role === 'teacher' && initialScreen === 'accounts' ? 'songs' : initialScreen);
  const [pieces, setPieces] = useState<Piece[]>(scenario === 'empty' ? [] : initialPieces);
  const [accounts, setAccounts] = useState<Account[]>(scenario === 'empty' ? initialAccounts.filter(a => a.role === 'admin') : initialAccounts);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('recent');
  const [selected, setSelected] = useState<string | null>(null);
  const [playingPiece, setPlayingPiece] = useState<Piece | null>(null);
  const [playerReturn, setPlayerReturn] = useState<'songs' | 'guest'>('songs');
  const [accountEmail, setAccountEmail] = useState<string | null>(null);
  const [accountMode, setAccountMode] = useState<'detail' | 'create' | 'reset'>('detail');
  const [status, setStatus] = useState(scenario);
  const [notice, setNotice] = useState('');
  const [shareURLs, setShareURLs] = useState<Record<string, string>>({});
  const [links, setLinks] = useState([{ id: 1, scope: 'list', active: true }]);
  const [confirm, setConfirm] = useState<{ kind: 'rotate' | 'revoke' | 'block'; link?: number } | null>(null);
  const piece = pieces.find(p => p.id === selected);
  const account = accounts.find(a => a.email === accountEmail);
  const scope = selected ?? 'list';
  const url = shareURLs[scope];
  const publicPieces = pieces.filter(p => p.state === 'published' && readyToPublish(p) && (!selected || p.id === selected));
  const activeLinks = links.filter(l => l.scope === scope && l.active);
  const go = (next: Screen) => { setScreen(next); setNotice(''); setConfirm(null); setQuery(''); window.scrollTo(0, 0); };
  function openShare(songId: string | null) { setSelected(songId); go('share'); }
  function changePublication(target: Piece) {
    if (target.state !== 'published' && !readyToPublish(target)) return;
    setPieces(current => current.map(p => p.id === target.id ? { ...p, state: p.state === 'published' ? 'draft' : 'published' } : p));
    setNotice(target.state === 'published'
      ? `«${target.title}»: публикация снята в макете. Ученики больше не видят песню.`
      : `«${target.title}» опубликована в макете и доступна ученикам по ссылке на список.`);
  }
  function issueLink(replacing?: number) {
    const nextId = Math.max(0, ...links.map(l => l.id)) + 1;
    setLinks(current => [...current.map(l => l.id === replacing ? { ...l, active: false } : l), { id: nextId, scope, active: true }]);
    setShareURLs(current => ({ ...current, [scope]: `https://example.invalid/?${selected ? 'song' : 'list'}=storybook-${nextId}` }));
    setConfirm(null); setNotice(replacing ? 'Старая ссылка отключена. Передайте ученикам новый адрес.' : 'Ссылка создана. Скопируйте и отправьте ученикам.');
  }
  async function copy() {
    try { await navigator.clipboard.writeText(url ?? ''); setNotice('Ссылка скопирована. Можно отправить ученикам.'); }
    catch { setNotice('Не удалось скопировать автоматически. Выделите адрес в поле и скопируйте вручную.'); }
  }
  const heading = screen === 'accounts' ? 'Аккаунты' : screen === 'account' ? accountMode === 'create' ? 'Новый преподаватель' : accountMode === 'reset' ? 'Сбросить пароль' : 'Аккаунт' : screen === 'share' ? selected ? 'Ссылка на песню' : 'Ссылка на список' : 'Песни';

  if (screen === 'editor') return <div className={styles.root}>
    <div className={styles.editorBack}><small>Макет: файлы не отправляются</small></div>
    <CreateSong key={selected ?? 'new'} live {...(piece ? { initialSong: defaultForm(piece) } : {})}
      status={notice} onCancel={() => go('songs')}
      {...(piece ? {
        publication: piece.state === 'published' ? 'published' as const : 'draft' as const,
        audioReady: readyToPublish(piece),
      } : {})}
      onSave={value => {
        const saved: Piece = { id: selected ?? `fixture-${pieces.length + 1}`, title: value.title, bpm: value.bpm, parts: value.tracks.length, state: piece?.state ?? 'draft', form: value };
        setPieces(current => selected ? current.map(p => p.id === selected ? saved : p) : [...current, saved]);
        setSelected(saved.id); go('songs'); setNotice('Изменения сохранены в макете. Новые аудиофайлы здесь не загружаются и не обрабатываются.');
      }} />
  </div>;

  if (screen === 'player') return <div className={styles.root}>
    <div className={styles.editorBack}><Button variant="text" size="small" onClick={() => go(playerReturn)}>‹ К песням</Button><small>Предпросмотр без звука</small></div>
    <RehearsalPlayer pieceTitle={playingPiece?.title ?? 'Тихий вечер'} bars={16} />
  </div>;

  return <div className={styles.root}><div className={styles.shell}>
    {screen !== 'guest' && <nav className={styles.nav} aria-label="Разделы">
      <div><Button variant="tab" aria-current={screen === 'songs' || screen === 'share' ? 'page' : undefined} onClick={() => go('songs')}>Песни</Button>
      {role === 'admin' && <Button variant="tab" aria-current={screen === 'accounts' || screen === 'account' ? 'page' : undefined} onClick={() => go('accounts')}>Аккаунты</Button>}</div>
      <span>{role === 'admin' ? 'Администратор' : 'Преподаватель'}</span>
    </nav>}
    {screen === 'share' && <Button variant="text" size="small" className={styles.back} onClick={() => go('songs')}>‹ К песням</Button>}
    {screen === 'guest' && <Button variant="text" size="small" className={styles.back} onClick={() => go('share')}>‹ Завершить предпросмотр</Button>}
    {screen === 'account' && <Button variant="text" size="small" className={styles.back} onClick={() => { setAccountMode('detail'); go('accounts'); }}>‹ К аккаунтам</Button>}
    <main>
      <header className={styles.header}>
        <div><h1>{heading}{screen === 'songs' && <span className={styles.count}>{pieces.length}</span>}</h1>
          {screen === 'songs' && <p>Подготовьте партии и передайте песни ученикам.</p>}
          {screen === 'accounts' && <p>Доступ преподавателей к песням и работе с хором.</p>}
          {screen === 'share' && <p>{selected ? piece?.title : 'Все ваши опубликованные песни, готовые к прослушиванию.'}</p>}
          {screen === 'guest' && <p>Так выглядит список для ученика. Вход не нужен.</p>}
        </div>
        {screen === 'songs' && <div className={styles.headerActions}>
          <Button size="small" className={styles.secondary} onClick={() => openShare(null)}><LibraryIcon name="link" />Ссылка на список</Button>
          <Button variant="primary" size="small" className={styles.primary} onClick={() => { setSelected(null); go('editor'); }}><LibraryIcon name="add" />Песня</Button>
        </div>}
        {screen === 'accounts' && <Button variant="primary" size="small" className={styles.primary} onClick={() => { setAccountEmail(null); setAccountMode('create'); go('account'); }}><LibraryIcon name="add" />Преподаватель</Button>}
      </header>
      {notice && <Message tone="info" variant="banner" className={styles.notice} role="status">{notice}</Message>}

      {(screen === 'songs' || screen === 'guest') && <>
        <div className={styles.filters}>
          <label className={styles.search}><LibraryIcon name="search" /><span className="visually-hidden">Найти песню</span><Input id={`${id}-search`} name="songSearch" type="search" decoration="leadingIcon" value={query} placeholder="Найти песню" onChange={e => setQuery(e.target.value)} /></label>
          <label><span className="visually-hidden">Порядок песен</span><Select textSize="small" id={`${id}-sort`} name="songSort" value={sort} onChange={e => setSort(e.target.value)}><option value="recent">По обновлению</option><option value="title">По названию</option></Select></label>
        </div>
        {screen === 'songs' && status === 'loading' ? <Message tone="muted" className={styles.empty} role="status">Загружаем песни…</Message> : screen === 'songs' && status === 'error' ? <Message as="div" tone="error" className={styles.empty} role="alert"><h2>Не удалось загрузить песни</h2><p>Проверьте подключение и попробуйте ещё раз.</p><Button size="small" className={styles.secondary} onClick={() => setStatus('ready')}>Повторить загрузку</Button></Message> : <>
          <ul className={styles.list} aria-label="Песни">
            {(screen === 'guest' ? publicPieces : pieces).filter(p => p.title.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru'))).sort((a,b) => sort === 'title' ? a.title.localeCompare(b.title, 'ru') : 0).map(p => <li className={`${styles.song} ${screen === 'songs' && p.state === 'published' ? styles.songPublished : ''}`} key={p.id}>
              <div className={styles.songInfo}>
                <div className={styles.titleLine}>
              <Button variant="title" data-published={p.state === 'published'} onClick={() => { if (p.state === 'published') { setPlayingPiece(p); setPlayerReturn(screen === 'guest' ? 'guest' : 'songs'); go('player'); } else { setSelected(p.id); go('editor'); } }}>
                    <strong>{p.title}</strong>
                  </Button>
                  {screen !== 'guest' && <Button variant="switch" size="icon" type="button" role="switch"
                    aria-checked={p.state === 'published'} aria-label={`Публикация: ${p.title}`}
                    aria-describedby={`${id}-state-${p.id}`}
                    title={p.state === 'published' ? 'Снять с публикации' : readyToPublish(p) ? 'Опубликовать' : 'Публикация недоступна: не все партии готовы'}
                    disabled={p.state !== 'published' && !readyToPublish(p)} onClick={() => changePublication(p)}>
                    <span aria-hidden="true"><span /></span>
                  </Button>}
                </div>
                <p className={styles.songMetadata}>Партий: {p.parts} <span aria-hidden="true">/</span> {p.bpm} BPM <span aria-hidden="true">/</span> 4/4</p>
              </div>
              {screen !== 'guest' && <><div className={styles.publication}>
                <span id={`${id}-state-${p.id}`} className={p.state === 'published' ? styles.published : styles.state}>{stateLabel[p.state]}</span>
                {p.state !== 'processing' && !readyToPublish(p) && <span className={styles.state}>Сначала подготовьте все партии</span>}
              </div>
                <div className={styles.rowActions}>
                  <Button size="icon" title="Редактировать" aria-label={`Редактировать: ${p.title}`} onClick={() => { setSelected(p.id); go('editor'); }}><LibraryIcon name="edit" /></Button>
                  <Button size="small" className={styles.linkButton} aria-label={`Ссылка: ${p.title}`} onClick={() => openShare(p.id)}><LibraryIcon name="link" /><span>Ссылка</span></Button>
                </div></>}
            </li>)}
          </ul>
          {!(screen === 'guest' ? publicPieces : pieces).some(p => p.title.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru'))) && <div className={styles.empty}><h2>{query ? 'Ничего не найдено' : 'Пока нет песен'}</h2><p>{query ? 'Попробуйте другое название.' : 'Начните с названия и голосовых партий. Черновик можно сохранить без файлов.'}</p>{query ? <Button size="small" className={styles.secondary} onClick={() => setQuery('')}>Сбросить поиск</Button> : screen !== 'guest' && <Button variant="primary" size="small" className={styles.primary} onClick={() => { setSelected(null); go('editor'); }}>Создать первую песню</Button>}</div>}
          {screen === 'songs' && pieces.some(p => p.state !== 'published') && <p className={styles.footnote}>Черновики и песни с неготовым аудио ученики не увидят.</p>}
        </>}
      </>}

      {screen === 'share' && <>
        <section className={styles.shareContents} aria-labelledby={`${id}-contents`}>
          <div className={styles.sectionHeading}><h2 id={`${id}-contents`}>Что откроется ученику</h2><span>Песен: {publicPieces.length}</span></div>
          {publicPieces.length ? <><ul className={styles.previewList}>{publicPieces.map(p => <li key={p.id}><span>{p.title}</span><span>Партий: {p.parts}</span></li>)}</ul>
            <Button variant="text" size="small" onClick={() => go('guest')}>Посмотреть как ученик</Button></> :
            <div className={styles.empty}><h3>{piece?.state === 'processing' ? 'Дождитесь обработки аудио' : 'Сначала подготовьте песню'}</h3><p>{piece?.state === 'processing' ? 'Когда все партии будут готовы, песню можно опубликовать.' : 'Добавьте аудио к партиям и опубликуйте сохранённую песню. После этого её можно передать ученикам.'}</p><Button size="small" className={styles.secondary} onClick={() => go(piece ? 'editor' : 'songs')}>{piece ? 'Открыть редактор' : 'К песням'}</Button></div>}
          {!selected && <p className={styles.help}>Список обновляется автоматически: новые опубликованные песни появятся по этой же ссылке.</p>}
        </section>
        {publicPieces.length > 0 && <section className={styles.delivery} aria-label="Передать ссылку">
          <h2>{url ? 'Ссылка готова' : 'Передать ученикам'}</h2>
          <p>Любой, кому перешлют ссылку, сможет слушать песни. Редактирование недоступно.</p>
          {url ? <><label className={styles.field}>Адрес для учеников<Input id={`${id}-url`} name="shareUrl" readOnly value={url} onFocus={e => e.target.select()} /></label><Button variant="primary" size="small" className={styles.primary} onClick={() => void copy()}>Копировать ссылку</Button><p className={styles.help}>Сохраните адрес у себя: после перезагрузки он больше не отображается.</p></> :
            <Button variant="primary" size="small" className={styles.primary} onClick={() => issueLink()}><LibraryIcon name="link" />Создать ссылку</Button>}
        </section>}
        <section className={styles.history} aria-label="Выданные ссылки"><h2>Выданные ссылки <span className={styles.count}>{activeLinks.length}</span></h2>
          {!activeLinks.length && <p className={styles.help}>Действующих ссылок пока нет.</p>}
          {activeLinks.length > 0 && <p className={styles.help}>Ранее выданный адрес нельзя показать повторно. Создайте дополнительную ссылку или замените старую.</p>}
          {activeLinks.map(l => <div className={styles.linkRow} key={l.id}><div><strong>Ссылка №{l.id}</strong><span className={styles.published}>Действует</span></div><div className={styles.rowActions}>
            <Button variant="text" size="small" disabled={!publicPieces.length} onClick={() => setConfirm({ kind: 'rotate', link: l.id })}>Заменить</Button>
            <Button variant="dangerText" size="small" onClick={() => setConfirm({ kind: 'revoke', link: l.id })}>Отключить</Button>
          </div></div>)}
          {url && <Button variant="text" size="small" onClick={() => issueLink()}>Создать ещё одну ссылку</Button>}
        </section>
        {confirm && confirm.kind !== 'block' && <Message as="section" tone="error" variant="confirmation" className={styles.confirm} role="alert" aria-label="Подтверждение действия со ссылкой">
          <h2>{confirm.kind === 'rotate' ? 'Заменить ссылку?' : 'Отключить ссылку?'}</h2><p>Старый адрес перестанет открываться у всех, кому вы его отправили. Другие ссылки продолжат работать.</p>
          <div className={styles.actions}><Button variant="danger" size="small" onClick={() => {
            if (confirm.kind === 'rotate') issueLink(confirm.link);
            else { setLinks(current => current.map(l => l.id === confirm.link ? { ...l, active: false } : l)); setShareURLs(current => url?.endsWith(`-${confirm.link}`) ? { ...current, [scope]: '' } : current); setConfirm(null); setNotice('Ссылка отключена.'); }
          }}>{confirm.kind === 'rotate' ? 'Заменить ссылку' : 'Отключить ссылку'}</Button><Button size="small" className={styles.secondary} onClick={() => setConfirm(null)}>Отмена</Button></div>
        </Message>}
      </>}

      {screen === 'accounts' && <>
        <label className={styles.search}><LibraryIcon name="search" /><span className="visually-hidden">Найти аккаунт</span><Input id={`${id}-account-search`} name="accountSearch" type="search" decoration="leadingIcon" placeholder="Найти по email" value={query} onChange={e => setQuery(e.target.value)} /></label>
        {status === 'loading' ? <Message tone="muted" role="status" className={styles.empty}>Загружаем аккаунты…</Message> : status === 'error' ? <Message as="div" tone="error" role="alert" className={styles.empty}><h2>Не удалось загрузить аккаунты</h2><p>Проверьте подключение и повторите запрос.</p><Button size="small" className={styles.secondary} onClick={() => setStatus('ready')}>Повторить загрузку</Button></Message> : <>
          <ul className={styles.list} aria-label="Аккаунты">{accounts.filter(a => a.email.includes(query.trim().toLowerCase())).map(a => <li key={a.email}>
            <Button variant="row" className={styles.accountRow} onClick={() => { setAccountEmail(a.email); setAccountMode('detail'); go('account'); }}>
              <span><strong>{a.email}</strong><small>{a.role === 'admin' ? 'Администратор · это вы' : 'Преподаватель'}</small></span>
              <span className={a.blocked ? styles.blocked : a.temporary ? styles.state : styles.published}>{a.blocked ? 'Заблокирован' : a.temporary ? 'Нужна смена пароля' : 'Активен'}</span><span aria-hidden="true">›</span>
            </Button></li>)}</ul>
          {!accounts.some(a => a.role === 'teacher') && <div className={styles.empty}><h2>Преподавателей пока нет</h2><p>Создайте аккаунт и передайте временный пароль лично.</p></div>}
          {!accounts.some(a => a.email.includes(query.trim().toLowerCase())) && <p className={styles.empty}>Аккаунт не найден. Попробуйте другой email.</p>}
        </>}
        <p className={styles.footnote}>Участникам хора аккаунт не нужен — достаточно ссылки на песни.</p>
      </>}

      {screen === 'account' && <>
        {(accountMode === 'create' || accountMode === 'reset') ? <AccountForm key={accountMode + accountEmail} mode={accountMode} email={accountEmail ?? ''} existingEmails={accounts.map(a => a.email)} onCancel={() => go('accounts')} onDone={email => {
          if (accountMode === 'create') setAccounts(current => [...current, { email, role: 'teacher', blocked: false, temporary: true }]);
          else setAccounts(current => current.map(a => a.email === email ? { ...a, temporary: true } : a));
          const text = accountMode === 'create' ? 'Преподаватель создан в макете. Передайте ему email и временный пароль лично.' : 'Пароль сброшен в макете. Все сессии отозваны; при входе потребуется сменить пароль.';
          go('accounts'); setNotice(text);
        }} /> : account && <>
          <div className={styles.accountSummary}><strong>{account.email}</strong><span>{account.role === 'admin' ? 'Администратор' : 'Преподаватель'}</span><span className={account.blocked ? styles.blocked : styles.published}>{account.blocked ? 'Заблокирован' : 'Активен'}</span></div>
          <section className={styles.settingRow}><div><h2>Вход в аккаунт</h2><p>{account.temporary ? 'При следующем входе потребуется сменить временный пароль.' : 'Если преподаватель забыл пароль, задайте временный и передайте лично.'}</p></div><Button size="small" className={styles.secondary} disabled={account.role === 'admin'} onClick={() => { setAccountMode('reset'); setNotice(''); }}>Сбросить пароль</Button></section>
          <section className={styles.settingRow}><div><h2>{account.blocked ? 'Вернуть доступ' : 'Заблокировать доступ'}</h2><p>{account.blocked ? 'Преподаватель снова сможет войти с текущим паролем.' : 'Текущие сессии завершатся. Песни и выданные ссылки сохранятся.'}</p></div>
            <Button variant={account.blocked ? 'neutral' : 'dangerText'} size="small" disabled={account.role === 'admin'} onClick={() => {
              if (account.blocked) { setAccounts(current => current.map(a => a.email === account.email ? { ...a, blocked: false } : a)); setNotice('Доступ восстановлен в макете.'); }
              else setConfirm({ kind: 'block' });
            }}>{account.blocked ? 'Разблокировать' : 'Заблокировать'}</Button></section>
          {account.role === 'admin' && <Message tone="info" variant="banner" className={styles.notice}>Это единственный активный администратор. Его нельзя заблокировать. Для своего пароля используйте смену пароля; восстановление доступа выполняет оператор.</Message>}
          {confirm?.kind === 'block' && <Message as="section" tone="error" variant="confirmation" className={styles.confirm} role="alert"><h2>Заблокировать преподавателя?</h2><p>{account.email} потеряет доступ. Все его текущие сессии завершатся.</p><div className={styles.actions}><Button variant="danger" size="small" onClick={() => { setAccounts(current => current.map(a => a.email === account.email ? { ...a, blocked: true } : a)); setConfirm(null); setNotice('Аккаунт заблокирован в макете.'); }}>Подтвердить блокировку</Button><Button size="small" className={styles.secondary} onClick={() => setConfirm(null)}>Отмена</Button></div></Message>}
        </>}
      </>}
    </main>
  </div></div>;
}

function AccountForm({ mode, email, existingEmails, onDone, onCancel }: { mode: 'create' | 'reset'; email: string; existingEmails: string[]; onDone: (email: string) => void; onCancel: () => void }) {
  const id = useId();
  const [address, setAddress] = useState(email);
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  return <form className={styles.accountForm} onSubmit={event => {
    event.preventDefault();
    const normalized = address.normalize('NFC').trim().toLowerCase();
    if (mode === 'create' && existingEmails.includes(normalized)) { setError('Этот email уже используется. Найдите аккаунт в списке.'); return; }
    if ([...password].length < 12 || [...password].length > 128) { setError('Временный пароль должен содержать от 12 до 128 символов.'); return; }
    setPassword(''); onDone(normalized);
  }}>
    {mode === 'create' ? <label className={styles.field}>Email преподавателя<Input id={`${id}-email`} name="email" type="email" maxLength={254} autoComplete="off" required placeholder="teacher@example.invalid" value={address} onChange={e => setAddress(e.target.value)} /></label> : <p className={styles.accountSummary}>{email}</p>}
    <label className={styles.field}>Временный пароль<Input id={`${id}-password`} name="temporaryPassword" type={show ? 'text' : 'password'} autoComplete="new-password" required value={password} aria-describedby={`${id}-help`} onChange={e => setPassword(e.target.value)} /></label>
    <Checkbox id={`${id}-show`} name="showPassword" checked={show} onChange={e => setShow(e.target.checked)} >Показать пароль</Checkbox>
    <p className={styles.help} id={`${id}-help`}>От 12 до 128 символов. Передайте пароль лично. При первом входе преподаватель задаст свой пароль.</p>
    {mode === 'reset' && <Message tone="error" variant="banner" className={styles.warning}>Текущий пароль перестанет работать, все сессии завершатся. Блокировка аккаунта при этом не снимается.</Message>}
    {error && <Message tone="error" variant="banner" className={styles.warning} role="alert">{error}</Message>}
    <div className={styles.actions}><Button variant="primary" size="small" className={styles.primary} type="submit">{mode === 'create' ? 'Создать преподавателя' : 'Сбросить пароль'}</Button><Button size="small" className={styles.secondary} type="button" onClick={onCancel}>Отмена</Button></div>
    <p className={styles.footnote}>Storybook: используйте вымышленные данные. Форма ничего не отправляет.</p>
  </form>;
}
