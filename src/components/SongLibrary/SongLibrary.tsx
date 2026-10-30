import { Select } from '../ui/Select';
import { Input } from '../ui/Input';
import { ActionLink } from '../ui/ActionLink';
import { Button } from '../ui/Button';
import { useId, useState } from 'react';
import { appUrl } from '../../navigation/appUrl';
import { CreateSong } from '../CreateSong/CreateSong';
import type { SongFormValue } from '../CreateSong/CreateSong';
import type { LibrarySong } from './LibrarySong';
import { LibraryIcon } from './LibraryIcon';
import styles from './SongLibrary.module.css';

export interface SongLibraryProps {
  live?: { canEdit: (song: LibrarySong) => boolean; onEdit: (id: string) => void; onShare: (id?: string) => void; onFilter: (query: string, sort: string) => void };
  loading?: boolean;
  error?: string;
  songHref?: (id: string) => string;
  role?: 'guest' | 'teacher' | 'admin';
  songs?: LibrarySong[];
  /** Для story «Поиск без результатов». */
  initialQuery?: string;
}

export function SongLibrary({ role = 'guest', songs = [], initialQuery = '', songHref, live, loading, error }: SongLibraryProps) {
  const id = useId();
  const [query, setQuery] = useState(initialQuery);
  const [sort, setSort] = useState('recent');
  const [notice, setNotice] = useState('');
  const [librarySongs, setLibrarySongs] = useState(songs);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, SongFormValue>>({});
  const canEdit = (song: LibrarySong) => live ? live.canEdit(song) : role === 'admin' || (role === 'teacher' && song.owner === 'Преподаватель');
  const canCreate = role !== 'guest';
  const available = live ? songs : librarySongs.filter((song) => song.shared || canEdit(song));
  const editingSong = librarySongs.find((song) => song.id === editingId && canEdit(song));

  async function copyLink(query: string, success: string) {
    try {
      await navigator.clipboard.writeText(appUrl(query));
      setNotice(success);
    } catch { setNotice('Не удалось скопировать ссылку. Попробуйте ещё раз.'); }
  }

  if (editingSong) {
    const [beats, unit] = editingSong.meter.split('/').map(Number);
    const names = ['Сопрано', 'Альт', 'Тенор', 'Бас', 'Минус'];
    const initialSong = drafts[editingSong.id] ?? {
      title: editingSong.title, bpm: editingSong.bpm, beatsPerBar: beats ?? 4, beatUnit: unit ?? 4,
      tracks: Array.from({ length: editingSong.tracks }, (_, index) => ({
        name: names[index] ?? `Трек ${index + 1}`, existingFileName: `track-${index + 1}.m4a`,
      })), notes: '',
    };
    return <CreateSong key={editingSong.id} initialSong={initialSong}
      onCancel={() => { setEditingId(null); window.scrollTo(0, 0); }}
      onSave={(value) => {
        setDrafts((current) => ({ ...current, [editingSong.id]: value }));
        setLibrarySongs((current) => current.map((song) => song.id === editingSong.id ? {
          ...song, title: value.title, bpm: value.bpm, meter: `${value.beatsPerBar}/${value.beatUnit}`,
          tracks: value.tracks.length, updatedAt: new Date().toISOString().slice(0, 10),
        } : song));
        setEditingId(null); setNotice('Изменения сохранены в макете. После перезагрузки они сбросятся.');
        window.scrollTo(0, 0);
      }} />;
  }
  const matches = live ? available : available.filter((song) => song.title.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru')))
    .sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title, 'ru') : b.updatedAt.localeCompare(a.updatedAt));

  const hasSearch = Boolean(query.trim()) || available.length > 0;
  return <main className={styles.page}>
    <div className={styles.content}>
      <header className={styles.header}>
        <div className={styles.heading}><h1>Песни</h1><span className={styles.count} aria-label={`Песен: ${available.length}`}>{available.length}</span></div>
        {canCreate && <div className={styles.headerActions}>
          <Button size="icon" type="button" aria-label="Ссылка на список" title="Скопировать ссылку на список"
            onClick={() => live ? live.onShare() : copyLink('?page=library&list=choir-demo', 'Демо-ссылка на список скопирована.')}>
            <LibraryIcon name="link" />
          </Button>
          <ActionLink variant="primary" size="icon" href={appUrl('?page=create-song')} target="_top" aria-label="Создать песню" title="Создать песню">
            <LibraryIcon name="add" />
          </ActionLink>
        </div>}
      </header>
      {(live || available.length > 0) && <div className={styles.filters}>
        <label className={styles.search} htmlFor={`${id}-search`}><span className="visually-hidden">Найти песню</span>
          <LibraryIcon name="search" />
          <Input id={`${id}-search`} name="songSearch" type="search" decoration="leadingIcon" placeholder="Поиск" value={query}
            onChange={(event) => { setQuery(event.target.value); live?.onFilter(event.target.value, sort); }} />
        </label>
        <label className={styles.sort} htmlFor={`${id}-sort`}><span className="visually-hidden">Порядок песен</span>
          <Select textSize="small" id={`${id}-sort`} name="songSort" value={sort} onChange={(event) => { setSort(event.target.value); live?.onFilter(query, event.target.value); }}>
            <option value="recent">Новые</option><option value="title">По названию</option>
          </Select>
        </label>
      </div>}
      {notice && <p className={styles.notice} role="status">{notice}</p>}
      {loading ? <p role="status">Загрузка песен…</p> : error ? <p role="alert">{error}</p> : matches.length > 0 ? <ul className={styles.list} aria-label="Песни">
        {matches.map((song) => <li className={styles.song} key={song.id}>
          <a className={styles.songLink} href={songHref ? songHref(song.id) : appUrl(`?song=${song.id}`)} target="_top" aria-label={`Открыть: ${song.title}`}>
            <h2>{song.title}</h2>
            <p className={styles.metadata}>{song.bpm} BPM <span>·</span> {song.meter} <span>·</span> {song.tracks} треков</p>
            {role === 'admin' && <p className={styles.owner}>{song.owner}</p>}
          </a>
          <div className={styles.actions}>
            {canEdit(song) && <Button size="icon" type="button" aria-label={`Редактировать: ${song.title}`} title="Редактировать песню"
              onClick={() => { if (live) { live.onEdit(song.id); return; } setEditingId(song.id); setNotice(''); window.scrollTo(0, 0); }}><LibraryIcon name="edit" /></Button>}
            <Button size="icon" type="button" disabled={live ? !canEdit(song) : !song.shared} aria-label={`Скопировать ссылку: ${song.title}`}
              title={song.shared ? 'Скопировать ссылку на песню' : 'Песня не опубликована'}
              onClick={() => live ? live.onShare(song.id) : copyLink(songHref ? new URL(songHref(song.id)).search : `?song=${song.id}`, `${songHref ? 'Ссылка' : 'Демо-ссылка'} на «${song.title}» скопирована.`)}>
              <LibraryIcon name={song.shared ? 'link' : 'private'} />
            </Button>
          </div>
        </li>)}
      </ul> : <section className={styles.empty} aria-label={hasSearch ? 'Ничего не найдено' : 'Нет песен'}>
        <h2>{hasSearch ? 'Песня не найдена' : 'Пока нет песен'}</h2>
        <p>{hasSearch ? 'Попробуйте другое название.' : (canCreate ? 'Создайте первую песню и добавьте голосовые партии.' : 'В этом списке пока нет песен, доступных по ссылке.')}</p>
        {hasSearch && <Button size="small" type="button" onClick={() => { setQuery(''); live?.onFilter('', sort); }}>Сбросить поиск</Button>}
      </section>}
    </div>
  </main>;
}
