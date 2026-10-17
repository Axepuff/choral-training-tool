import { useId, useState } from 'react';
import { appUrl } from '../../navigation/appUrl';
import { CreateSong } from '../CreateSong/CreateSong';
import type { SongFormValue } from '../CreateSong/CreateSong';
import { mockSongs } from './mockSongs';
import type { LibrarySong } from './mockSongs';
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
      <header className={styles.header}><div><h1>Песни</h1>
        <p>Материалы для репетиций хора</p></div>
        <div className={styles.headerActions}>
          {canCreate && <a className={styles.create} href={appUrl('?page=create-song')} target="_top">Создать песню</a>}
          <button className={styles.listLink} type="button" onClick={() => copyLink('?page=library&list=choir-demo', 'Демо-ссылка на список скопирована.')}>
            Ссылка на список
          </button>
        </div>
      </header>
      {available.length > 0 && <div className={styles.filters}>
        <label className={styles.search} htmlFor={`${id}-search`}><span className="visually-hidden">Найти песню</span>
          <input id={`${id}-search`} name="songSearch" type="search" placeholder="Найти песню" value={query}
            onChange={(event) => setQuery(event.target.value)} />
        </label>
        <label className={styles.sort} htmlFor={`${id}-sort`}><span className="visually-hidden">Порядок песен</span>
          <select id={`${id}-sort`} name="songSort" value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="recent">Сначала новые</option><option value="title">По названию</option>
          </select>
        </label>
      </div>}
      {notice && <p className={styles.notice} role="status">{notice}</p>}
      {matches.length > 0 ? <ul className={styles.list} aria-label="Песни">
        {matches.map((song) => <li className={styles.song} key={song.id}>
          <div className={styles.details}><h2><a href={appUrl(`?song=${song.id}`)} target="_top">{song.title}</a></h2>
            <p className={styles.metadata}>{song.bpm} BPM <span>·</span> {song.meter} <span>·</span> {song.tracks} треков</p>
            {role === 'admin' && <p className={styles.owner}>Владелец: {song.owner}</p>}
            <p className={styles.sharing}>{song.shared ? 'Доступна по ссылке' : 'Ссылка не включена'}</p>
          </div>
          <div className={styles.actions}>
            <a className={styles.open} href={appUrl(`?song=${song.id}`)} target="_top" aria-label={`Открыть: ${song.title}`}>Открыть</a>
            {canEdit(song) && <button type="button" aria-label={`Редактировать: ${song.title}`}
              onClick={() => { setEditingId(song.id); setNotice(''); window.scrollTo(0, 0); }}>Редактировать</button>}
            <button type="button" disabled={!song.shared} aria-label={`Скопировать ссылку: ${song.title}`}
              title={song.shared ? 'Скопировать демо-ссылку' : 'Ссылка пока не включена'}
              onClick={() => copyLink(`?song=${song.id}`, `Демо-ссылка на «${song.title}» скопирована.`)}>Ссылка</button>
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
