import { useId, useRef, useState } from 'react';
import styles from './CreateSong.module.css';

const defaultNames = ['Сопрано', 'Альт', 'Тенор', 'Бас', 'Минус'];
interface TrackDraft { name: string; file?: File }
export interface CreateSongProps {
  /** Заполненные текстовые поля для демонстрации. Файлы выбираются локально. */
  initialFilled?: boolean;
}

function TrackRow({ track, index, onChange }: {
  track: TrackDraft; index: number; onChange: (track: TrackDraft) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const id = useId();
  return <div className={styles.track}>
    <span className={styles.number} aria-hidden="true">{index + 1}</span>
    <label className={styles.trackName}>
      <span className="visually-hidden">Название трека {index + 1}</span>
      <input id={`${id}-name`} name={`tracks[${index}].name`} required maxLength={80} value={track.name} placeholder="Название партии"
        onChange={(event) => onChange({ ...track, name: event.target.value })} />
    </label>
    <button className={styles.upload} type="button" onClick={() => fileRef.current?.click()}
      aria-label={`${track.file ? 'Заменить' : 'Выбрать'} файл трека ${index + 1}`} title={track.file ? 'Заменить аудиофайл' : 'Выбрать аудиофайл'}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        <path d="M9 3H4v18h11V9L9 3ZM9 3v6h6M10 12v5" />
        <ellipse cx="8" cy="17" rx="2" ry="1.5" />
        <path d="M20 14V4m-3 3 3-3 3 3" />
      </svg>
    </button>
    <input id={`${id}-file`} name={`tracks[${index}].file`} ref={fileRef} type="file" hidden aria-label={`Аудиофайл трека ${index + 1}`}
      onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) onChange({ ...track, file });
        event.target.value = '';
      }} />
    <div className={styles.fileInfo}>
      <span title={track.file?.name}>{track.file ? track.file.name : 'Файл не выбран'}</span>
      {track.file && <button type="button" aria-label={`Убрать файл трека ${index + 1}`}
        onClick={() => onChange({ name: track.name })}>Убрать</button>}
    </div>
  </div>;
}

/** Макет формы: файлы остаются в памяти браузера, запросы на сервер не выполняются. */
export function CreateSong({ initialFilled = false }: CreateSongProps) {
  const id = useId();
  const [title, setTitle] = useState(initialFilled ? 'Тихий вечер' : '');
  const [bpm, setBpm] = useState('84');
  const [beats, setBeats] = useState('4');
  const [unit, setUnit] = useState('4');
  const [count, setCount] = useState(5);
  const [tracks, setTracks] = useState<TrackDraft[]>(() => Array.from({ length: 32 }, (_, index) => ({ name: defaultNames[index] ?? `Трек ${index + 1}` })));
  const [notes, setNotes] = useState(initialFilled ? 'Вступление — мягко. Обратить внимание на дыхание перед третьим тактом.' : '');
  const [message, setMessage] = useState('');
  const visibleTracks = tracks.slice(0, count);
  const selected = visibleTracks.filter((track) => track.file).length;

  return <main className={styles.shell}>
    <form className={styles.card} onChange={() => setMessage('')} onSubmit={(event) => {
      event.preventDefault();
      if (!title.trim() || visibleTracks.some((track) => !track.name.trim())) {
        setMessage('Укажите название песни и названия всех треков.'); return;
      }
      if (selected !== count) { setMessage('Выберите файл для каждого трека.'); return; }
      setMessage('Форма заполнена. Это макет: песня не сохранена, файлы не отправлены.');
    }}>
      <h1>Новая песня</h1>
      <p className={styles.intro}>Добавьте партии, чтобы подготовить репетицию.</p>
      <label className={styles.field}>Название песни
        <input id={`${id}-title`} name="title" required maxLength={160} placeholder="Например, Тихий вечер" value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <div className={styles.settings}>
        <label className={styles.field}>Темп, BPM
          <input id={`${id}-bpm`} name="bpm" type="number" required min={20} max={300} step={1} inputMode="numeric" value={bpm} onChange={(event) => setBpm(event.target.value)} />
        </label>
        <fieldset className={styles.meter}><legend>Размер</legend><div>
          <input id={`${id}-beats`} name="beatsPerBar" aria-label="Долей в такте" type="number" required min={1} max={32} step={1} value={beats} onChange={(event) => setBeats(event.target.value)} />
          <span aria-hidden="true">/</span>
          <select id={`${id}-unit`} name="beatUnit" aria-label="Длительность доли" value={unit} onChange={(event) => setUnit(event.target.value)}>
            {[1, 2, 4, 8, 16, 32].map((value) => <option key={value}>{value}</option>)}
          </select>
        </div></fieldset>
      </div>
      <section className={styles.tracks} aria-labelledby={`${id}-tracks`}>
        <div className={styles.sectionHeader}><h2 id={`${id}-tracks`}>Треки</h2>
          <label>Количество <select id={`${id}-count`} name="trackCount" aria-label="Количество треков" value={count} onChange={(event) => { setCount(Number(event.target.value)); setMessage(''); }}>
            {Array.from({ length: 32 }, (_, index) => <option key={index}>{index + 1}</option>)}
          </select></label>
        </div>
        <p className={styles.help}>Один файл на партию. Можно добавить минус.</p>
        <div className={styles.trackList}>
          {visibleTracks.map((track, index) => <TrackRow key={index} index={index} track={track} onChange={(updated) => {
            setTracks((current) => current.map((item, position) => position === index ? updated : item)); setMessage('');
          }} />)}
        </div>
        <p className={styles.help}>Выбрано файлов: {selected} из {count}</p>
        <details className={styles.formats}><summary>Какие файлы можно добавить?</summary>
          <p>Планируем MP3, WAV, FLAC, M4A/AAC, OGG/Opus, AIFF, ALAC, WMA и другие аудиоформаты. Выбор файла не ограничен расширением; совместимость будет проверяться на сервере.</p>
          <p>В готовом сервисе файл будет преобразован для воспроизведения, а оригинал удалён после успешной обработки. Храните исходники у себя.</p>
        </details>
      </section>
      <label className={styles.field}>Заметки <span className={styles.optional}>необязательно</span>
        <textarea id={`${id}-notes`} name="notes" rows={4} maxLength={1000} value={notes} placeholder="Вступления, дыхание, сложные места…"
          aria-describedby={`${id}-notes-count`} onChange={(event) => setNotes(event.target.value)} />
      </label>
      <div className={styles.counter} id={`${id}-notes-count`}>{notes.length} / 1000</div>
      {message && <p className={styles.message} role="status">{message}</p>}
      <button className={styles.submit} type="submit">Создать песню</button>
      <p className={styles.demo}>Демо: файлы остаются на устройстве и не загружаются на сервер.</p>
    </form>
  </main>;
}
