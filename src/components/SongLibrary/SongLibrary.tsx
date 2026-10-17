import { useId, useState } from 'react';
import { mockSongs } from './mockSongs';
import type { LibrarySong } from './mockSongs';
import styles from './SongLibrary.module.css';

export interface SongLibraryProps {
  role?: 'teacher' | 'admin';
  songs?: LibrarySong[];
  /** Для story «Поиск без результатов». */
  initialQuery?: string;
}

export function SongLibrary({ role = 'teacher', songs = mockSongs, initialQuery = '' }: SongLibraryProps) {
  const id = useId();
  const [query, setQuery] = useState(initialQuery);
  const [sort, setSort] = useState('recent');
  const [notice, setNotice] = useState('');
  const available = role === 'admin' ? songs : songs.filter((song) => song.owner === 'Преподаватель');
  const matches = available.filter((song) => song.title.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru')))
    .sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title, 'ru') : b.updatedAt.localeCompare(a.updatedAt));

  return <main className={styles.page}>
    <div className={styles.content}>
      <header className={styles.header}><div><h1>{role === 'admin' ? 'Все песни' : 'Мои песни'}</h1>
        <p>{role === 'admin' ? 'Песни всех преподавателей' : 'Материалы для репетиций хора'}</p></div>
        <a className={styles.create} href="?page=create-song">Создать песню</a>
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
          <div className={styles.details}><h2><a href={`?song=${song.id}`}>{song.title}</a></h2>
            <p className={styles.metadata}>{song.bpm} BPM <span>·</span> {song.meter} <span>·</span> {song.tracks} треков</p>
            {role === 'admin' && <p className={styles.owner}>Владелец: {song.owner}</p>}
            <p className={styles.sharing}>{song.shared ? 'Доступна по ссылке' : 'Ссылка не включена'}</p>
          </div>
          <div className={styles.actions}>
            <a className={styles.open} href={`?song=${song.id}`} aria-label={`Открыть: ${song.title}`}>Открыть</a>
            <button type="button" disabled={!song.shared} aria-label={`Скопировать ссылку: ${song.title}`}
              title={song.shared ? 'Скопировать демо-ссылку' : 'Ссылка пока не включена'} onClick={async () => {
                try {
                  const url = new URL(window.location.href);
                  url.pathname = url.pathname.replace(/(?:iframe|index)\.html$/, '');
                  url.search = `?song=${song.id}`; url.hash = '';
                  await navigator.clipboard.writeText(url.href);
                  setNotice(`Демо-ссылка на «${song.title}» скопирована.`);
                } catch { setNotice('Не удалось скопировать ссылку. Попробуйте ещё раз.'); }
              }}>Ссылка</button>
          </div>
        </li>)}
      </ul> : <section className={styles.empty} aria-label={available.length ? 'Ничего не найдено' : 'Нет песен'}>
        <h2>{available.length ? 'Песня не найдена' : 'Здесь будут ваши песни'}</h2>
        <p>{available.length ? 'Попробуйте другое название.' : 'Создайте первую песню и добавьте голосовые партии.'}</p>
        {available.length > 0 && <button type="button" onClick={() => setQuery('')}>Сбросить поиск</button>}
      </section>}
    </div>
  </main>;
}
