import { Select } from '../ui/Select';
import { Textarea } from '../ui/Textarea';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { useEffect, useId, useRef, useState } from 'react';
import styles from './CreateSong.module.css';

const defaultNames = ['Сопрано', 'Альт', 'Тенор', 'Бас', 'Минус'];
export interface TrackDraft { id?: string; gain?: number; name: string; file?: File; existingFileName?: string }
export interface SongFormValue {
  title: string;
  bpm: number;
  beatsPerBar: number;
  beatUnit: number;
  tracks: TrackDraft[];
  notes: string;
}
export interface CreateSongProps {
  /** Заполненные текстовые поля для демонстрации. Файлы выбираются локально. */
  initialFilled?: boolean;
  /** Существующая песня: та же форма используется для редактирования. */
  initialSong?: SongFormValue;
  onSave?: (song: SongFormValue) => void | Promise<void>;
  live?: boolean;
  busy?: boolean;
  status?: string;
  error?: string;
  onCancel?: () => void;
  trackStates?: string[] | undefined;
  publication?: 'draft' | 'published' | undefined;
  audioReady?: boolean | undefined;
  canListen?: boolean | undefined;
  onListen?: (() => void) | undefined;
  onPublish?: (() => void) | undefined;
}

function TrackRow({ track, index, onChange, state }: {
  state?: string | undefined; track: TrackDraft; index: number; onChange: (track: TrackDraft) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const selectedName = track.file?.name ?? track.existingFileName;
  return <div className={styles.track}>
    <span className={styles.number} aria-hidden="true">{index + 1}</span>
    <label className={styles.trackName}>
      <span className="visually-hidden">Название трека {index + 1}</span>
      <Input id={`${id}-name`} name={`tracks[${index}].name`} required value={track.name} placeholder="Название партии"
        onChange={(event) => onChange({ ...track, name: event.target.value })} />
    </label>
    <Button size="icon" type="button" onClick={() => fileRef.current?.click()}
      aria-label={`${selectedName ? 'Заменить' : 'Выбрать'} файл трека ${index + 1}`} title={selectedName ? 'Заменить аудиофайл' : 'Выбрать аудиофайл'}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        <path d="M9 3H4v18h11V9L9 3ZM9 3v6h6M10 12v5" />
        <ellipse cx="8" cy="17" rx="2" ry="1.5" />
        <path d="M20 14V4m-3 3 3-3 3 3" />
      </svg>
    </Button>
    <input id={`${id}-file`} name={`tracks[${index}].file`} ref={fileRef} type="file" hidden aria-label={`Аудиофайл трека ${index + 1}`}
      onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) onChange({ ...track, file });
        event.target.value = '';
      }} />
    <div className={styles.fileInfo}>
      <span title={selectedName}>{selectedName ?? 'Файл не выбран'}</span>
      {selectedName && (track.file || !track.id) && <Button variant="dangerText" size="small" className={styles.fileRemove} type="button" aria-label={`Убрать файл трека ${index + 1}`}
        onClick={() => { const { file: _file, ...rest } = track; void _file; onChange(track.id ? rest : { name: track.name }); }}>Убрать</Button>}
    </div>
    {track.file && track.existingFileName && <p className={styles.trackStatus}>Сохранённый файл: {track.existingFileName}</p>}
    {state && <p className={styles.trackStatus} role="status">{state}</p>}
  </div>;
}

/** Общая форма приложения и stories; сетевой сценарий передаётся через onSave. */
export function CreateSong({ initialFilled = false, initialSong, onSave, onCancel, live = false, busy = false, status, error, trackStates, publication, audioReady, canListen, onListen, onPublish }: CreateSongProps) {
  const id = useId();
  const [title, setTitle] = useState(initialSong?.title ?? (initialFilled ? 'Тихий вечер' : ''));
  const [bpm, setBpm] = useState(String(initialSong?.bpm ?? 84));
  const [beats, setBeats] = useState(String(initialSong?.beatsPerBar ?? 4));
  const [unit, setUnit] = useState(String(initialSong?.beatUnit ?? 4));
  const [count, setCount] = useState(initialSong?.tracks.length ?? 5);
  const [tracks, setTracks] = useState<TrackDraft[]>(() => Array.from({ length: 32 }, (_, index) => (initialSong?.tracks[index] ?? { name: defaultNames[index] ?? `Трек ${index + 1}` })));
  const [notes, setNotes] = useState(initialSong?.notes ?? (initialFilled ? 'Вступление — мягко. Обратить внимание на дыхание перед третьим тактом.' : ''));
  const [message, setMessage] = useState('');
  const leaving = useRef(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!live || (!dirty && !busy)) return;
    const warn = (event: BeforeUnloadEvent) => { if (!leaving.current) event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [live, dirty, busy]);
  const visibleTracks = tracks.slice(0, count).map((track, index) => {
    // Rows can only be appended/trimmed, never reordered. The server assigns IDs
    // in that order while the form is disabled; preserve local fields and Files.
    const saved = track.id ? initialSong?.tracks.find(t => t.id === track.id) : initialSong?.tracks[index];
    return saved ? { ...track, ...(saved.id ? { id: saved.id } : {}), ...(saved.existingFileName ? { existingFileName: saved.existingFileName } : {}) } : track;
  });
  const selected = visibleTracks.filter((track) => track.file || track.existingFileName).length;

  return <main className={styles.shell}>
    <form aria-busy={busy} className={styles.card} onChange={() => { setMessage(''); setDirty(true); }} onSubmit={(event) => {
      event.preventDefault();
      if (!title.trim() || visibleTracks.some((track) => !track.name.trim())) {
        setMessage('Укажите название песни и названия всех треков.'); return;
      }
      if (!live && selected !== count) { setMessage('Выберите файл для каждого трека.'); return; }
      if ([...title.normalize('NFC').trim()].length > 160 || [...notes.normalize('NFC')].length > 1000 || visibleTracks.some(t => [...t.name.normalize('NFC').trim()].length > 80) || [title, notes, ...visibleTracks.map(t => t.name)].some(t => t.includes('\0'))) {
        setMessage('Название: до 160 символов, трек: до 80, заметки: до 1000. Нулевой символ запрещён.'); return;
      }
      if (onSave) {
        void onSave({ title: title.trim(), bpm: Number(bpm), beatsPerBar: Number(beats), beatUnit: Number(unit),
          tracks: visibleTracks.map((track) => ({ ...track, name: track.name.trim() })), notes });
        return;
      }
      setMessage('Форма заполнена. Это макет: песня не сохранена, файлы не отправлены.');
    }}>
      <fieldset disabled={busy} className={styles.fields}>
      <h1>{initialSong ? 'Редактировать песню' : 'Новая песня'}</h1>
      <p className={styles.intro}>{initialSong ? 'Измените данные песни и голосовые партии.' : 'Добавьте партии, чтобы подготовить репетицию.'}</p>
      <label className={styles.field}>Название песни
        <Input id={`${id}-title`} name="title" required placeholder="Например, Тихий вечер" value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <div className={styles.settings}>
        <label className={styles.field}>Темп, BPM
          <Input id={`${id}-bpm`} name="bpm" type="number" required min={20} max={300} step={1} inputMode="numeric" value={bpm} onChange={(event) => setBpm(event.target.value)} />
        </label>
        <fieldset className={styles.meter}><legend>Размер</legend><div>
          <Input id={`${id}-beats`} name="beatsPerBar" aria-label="Долей в такте" type="number" required min={1} max={32} step={1} value={beats} onChange={(event) => setBeats(event.target.value)} />
          <span aria-hidden="true">/</span>
          <Select id={`${id}-unit`} name="beatUnit" aria-label="Длительность доли" value={unit} onChange={(event) => setUnit(event.target.value)}>
            {[1, 2, 4, 8, 16, 32].map((value) => <option key={value}>{value}</option>)}
          </Select>
        </div></fieldset>
      </div>
      <section className={styles.tracks} aria-labelledby={`${id}-tracks`}>
        <div className={styles.sectionHeader}><h2 id={`${id}-tracks`}>Треки</h2>
          <label>Количество <Select className={styles.trackCount} id={`${id}-count`} name="trackCount" aria-label="Количество треков" value={count} onChange={(event) => { setCount(Number(event.target.value)); setMessage(''); }}>
            {Array.from({ length: 32 }, (_, index) => <option key={index}>{index + 1}</option>)}
          </Select></label>
        </div>
        <p className={styles.help}>Один файл на партию. Можно добавить минус.{live && ' Черновик можно сохранить без файлов.'}</p>
        <div className={styles.trackList}>
          {visibleTracks.map((track, index) => <TrackRow key={index} state={trackStates?.[index]} index={index} track={track} onChange={(updated) => {
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
        <Textarea id={`${id}-notes`} name="notes" rows={4} value={notes} placeholder="Вступления, дыхание, сложные места…"
          aria-describedby={`${id}-notes-count`} onChange={(event) => setNotes(event.target.value)} />
      </label>
      <div className={styles.counter} id={`${id}-notes-count`}>{[...notes.normalize('NFC')].length} / 1000</div>
      {message && <p className={styles.message} role="status">{message}</p>}
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
      <div className={styles.actions}>
      <Button variant="primary" size="form" className={styles.submit} type="submit">{initialSong ? 'Сохранить изменения' : 'Создать песню'}</Button>
      {onCancel && <Button className={styles.cancel} type="button" onClick={() => { if (!live || !dirty || window.confirm('Отменить несохранённые изменения? Сохранённый черновик останется на сервере.')) { leaving.current = true; onCancel(); } }}>Отмена</Button>}
      {onListen && <Button className={styles.cancel} type="button" disabled={!canListen} onClick={onListen}>Слушать песню</Button>}
      {publication && <p className={styles.help}>Публикация: {publication === 'published' ? 'опубликована' : 'черновик'}. {audioReady ? 'Аудио готово.' : 'Есть неготовые дорожки.'}</p>}
      {onPublish && <Button className={styles.cancel} type="button" onClick={onPublish}>{publication === 'draft' ? 'Опубликовать сохранённую песню' : 'Снять публикацию'}</Button>}
      </div>
      </fieldset>
      {!live && <p className={styles.demo}>Демо: файлы остаются на устройстве и не загружаются на сервер.</p>}
    </form>
  </main>;
}
