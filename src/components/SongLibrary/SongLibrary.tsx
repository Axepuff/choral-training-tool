import { useId, useState } from 'react';
import { appUrl } from '../../navigation/appUrl';
import { CreateSong } from '../CreateSong/CreateSong';
import type { SongFormValue } from '../CreateSong/CreateSong';
import { mockSongs } from './mockSongs';
import type { LibrarySong } from './mockSongs';
import { LibraryIcon } from './LibraryIcon';
import styles from './SongLibrary.module.css';

export interface SongLibraryProps {
  role?: 'guest' | 'teacher' | 'admin';
  songs?: LibrarySong[];
  /** Для story «Поиск без результатов». */
  initialQuery?: string;
}

export function SongLibrary({ role = 'guest', songs = mockSongs, initialQuery = '' }: SongLibraryProps) {
  const id = useId();
  const [query, setQuery] = useState(initialQuery);
  const [sort, setSort] = useState('recent');
  const [notice, setNotice] = useState('');
  const [librarySongs, setLibrarySongs] = useState(songs);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, SongFormValue>>({});
  const canEdit = (song: LibrarySong) => role === 'admin' || (role === 'teacher' && song.owner === 'Преподаватель');
  const canCreate = role !== 'guest';
  const available = librarySongs.filter((song) => song.shared || canEdit(song));
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
  const matches = available.filter((song) => song.title.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru')))
    .sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title, 'ru') : b.updatedAt.localeCompare(a.updatedAt));

  return <main className={styles.page}>
    <div className={styles.content}>
      <header className={styles.header}>
        <div className={styles.heading}><h1>Песни</h1><span className={styles.count} aria-label={`Песен: ${available.length}`}>{available.length}</span></div>
        {canCreate && <div className={styles.headerActions}>
          <button className={styles.iconButton} type="button" aria-label="Ссылка на список" title="Скопировать ссылку на список"
            onClick={() => copyLink('?page=library&list=choir-demo', 'Демо-ссылка на список скопирована.')}>
            <LibraryIcon name="link" />
          </button>
          <a className={`${styles.iconButton} ${styles.create}`} href={appUrl('?page=create-song')} target="_top" aria-label="Создать песню" title="Создать песню">
            <LibraryIcon name="add" />
          </a>
        </div>}
      </header>
      {available.length > 0 && <div className={styles.filters}>
        <label className={styles.search} htmlFor={`${id}-search`}><span className="visually-hidden">Найти песню</span>
          <LibraryIcon name="search" />
          <input id={`${id}-search`} name="songSearch" type="search" placeholder="Поиск" value={query}
            onChange={(event) => setQuery(event.target.value)} />
        </label>
        <label className={styles.sort} htmlFor={`${id}-sort`}><span className="visually-hidden">Порядок песен</span>
          <select id={`${id}-sort`} name="songSort" value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="recent">Новые</option><option value="title">По названию</option>
          </select>
        </label>
      </div>}
      {notice && <p className={styles.notice} role="status">{notice}</p>}
      {matches.length > 0 ? <ul className={styles.list} aria-label="Песни">
        {matches.map((song) => <li className={styles.song} key={song.id}>
          <a className={styles.songLink} href={appUrl(`?song=${song.id}`)} target="_top" aria-label={`Открыть: ${song.title}`}>
            <h2>{song.title}</h2>
            <p className={styles.metadata}>{song.bpm} BPM <span>·</span> {song.meter} <span>·</span> {song.tracks} треков</p>
            {role === 'admin' && <p className={styles.owner}>{song.owner}</p>}
          </a>
          <div className={styles.actions}>
            {canEdit(song) && <button className={styles.iconButton} type="button" aria-label={`Редактировать: ${song.title}`} title="Редактировать песню"
              onClick={() => { setEditingId(song.id); setNotice(''); window.scrollTo(0, 0); }}><LibraryIcon name="edit" /></button>}
            <button className={styles.iconButton} type="button" disabled={!song.shared} aria-label={`Скопировать ссылку: ${song.title}`}
              title={song.shared ? 'Скопировать ссылку на песню' : 'Песня не опубликована'}
              onClick={() => copyLink(`?song=${song.id}`, `Демо-ссылка на «${song.title}» скопирована.`)}>
              <LibraryIcon name={song.shared ? 'link' : 'private'} />
            </button>
          </div>
        </li>)}
      </ul> : <section className={styles.empty} aria-label={available.length ? 'Ничего не найдено' : 'Нет песен'}>
        <h2>{available.length ? 'Песня не найдена' : 'Пока нет песен'}</h2>
        <p>{available.length ? 'Попробуйте другое название.' : (canCreate ? 'Создайте первую песню и добавьте голосовые партии.' : 'В этом списке пока нет песен, доступных по ссылке.')}</p>
        {available.length > 0 && <button type="button" onClick={() => setQuery('')}>Сбросить поиск</button>}
      </section>}
    </div>
  </main>;
}
