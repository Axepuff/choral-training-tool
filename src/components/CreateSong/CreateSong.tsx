import { Message } from '../ui/Message';
import { Select } from '../ui/Select';
import { Textarea } from '../ui/Textarea';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { useEffect, useId, useRef, useState } from 'react';
import styles from './CreateSong.module.css';

const defaultNames = ['Сопрано', 'Альт', 'Тенор', 'Бас', 'Минус'];
export interface TrackDraft { id?: string; gain?: number; name: string; file?: File; existingFileName?: string; audioReady?: boolean }
export interface SongFormValue {
  title: string;
  bpm: number;
  beatsPerBar: number;
  beatUnit: number;
  tracks: TrackDraft[];
  notes: string;
}
export interface TrackUploadState {
  phase: 'empty' | 'selected' | 'waiting' | 'uploading' | 'queued' | 'processing' | 'ready' | 'error' | 'unknown';
  file?: File | undefined;
  progress?: number | undefined;
  detail?: string | undefined;
  locked?: boolean | undefined;
}
const phaseLabels: Record<TrackUploadState['phase'], string> = {
  empty: 'Файл не добавлен', selected: 'Будет загружен при сохранении', waiting: 'Ожидает загрузки',
  uploading: 'Загружаем файл', queued: 'Файл загружен. Ожидает обработки', processing: 'Подготавливаем аудио…',
  ready: 'Готово к воспроизведению', error: 'Не удалось загрузить новый файл', unknown: 'Не удалось проверить результат',
};
function fileState(track: TrackDraft, state?: TrackUploadState): TrackUploadState {
  if (track.file) return state?.file === track.file ? state : { phase: 'selected', file: track.file };
  if (state && !state.file) return state;
  return { phase: (track.audioReady ?? !!track.existingFileName) ? 'ready' : 'empty' };
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
  trackStates?: (TrackUploadState | undefined)[] | undefined;
  onRetryFile?: ((index: number, file?: File) => void) | undefined;
  onFileChange?: ((index: number) => void) | undefined;
  publication?: 'draft' | 'published' | undefined;
  audioReady?: boolean | undefined;
  canListen?: boolean | undefined;
  onListen?: (() => void) | undefined;
  onPublish?: (() => void) | undefined;
}

function TrackRow({ track, index, onChange, state, onRetry, rowId }: {
  state: TrackUploadState; track: TrackDraft; index: number; onChange: (track: TrackDraft) => void;
  onRetry?: (() => void) | undefined; rowId: string;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const selected = !!track.file && state.phase !== 'ready';
  const problem = state.phase === 'error' || state.phase === 'unknown';
  const working = ['uploading', 'queued', 'processing'].includes(state.phase);
  return <div className={styles.track} id={rowId} tabIndex={-1}>
    <span className={styles.number} aria-hidden="true">{index + 1}</span>
    <label className={styles.trackName}>
      <span className="visually-hidden">Название трека {index + 1}</span>
      <Input id={`${id}-name`} name={`tracks[${index}].name`} required value={track.name} placeholder="Название партии"
        onChange={(event) => onChange({ ...track, name: event.target.value })} />
    </label>
    <Button className={styles.chooseFile} type="button" disabled={state.locked} onClick={() => fileRef.current?.click()}
      aria-label={`${track.file || track.existingFileName ? 'Заменить' : 'Выбрать'} файл трека ${index + 1}`}>
      {track.file || track.existingFileName ? 'Заменить файл' : 'Выбрать файл'}
    </Button>
    <input id={`${id}-file`} name={`tracks[${index}].file`} ref={fileRef} type="file" hidden disabled={state.locked} aria-label={`Аудиофайл трека ${index + 1}`}
      onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) onChange({ ...track, file });
        event.target.value = '';
      }} />
    <div className={styles.fileInfo}>
      {selected && track.existingFileName && <p><span className={styles.fileLabel}>{state.phase === 'unknown' ? 'Ранее сохранён: ' : 'Сейчас используется: '}</span>{track.existingFileName}</p>}
      {(track.file || track.existingFileName) && <p><span className={styles.fileLabel}>{selected ? 'Новый файл: ' : 'Файл: '}</span>{selected ? track.file!.name : track.existingFileName ?? track.file?.name}</p>}
      <p className={`${styles.fileStatus} ${state.phase === 'ready' ? styles.ready : problem ? styles.problem : ''}`} role="status" aria-atomic="true">
        <span aria-hidden="true">{state.phase === 'ready' ? '✓ ' : problem ? '! ' : ''}</span>{phaseLabels[state.phase]}
      </p>
      {working && <div className={styles.transfer}>
        <progress className={styles.progress} max={100} value={state.phase === 'uploading' ? state.progress : undefined} aria-label={`Загрузка файла: ${track.name}`} />
        {state.phase === 'uploading' && state.progress !== undefined && <span aria-hidden="true">{state.progress}%</span>}
      </div>}
      {state.detail && <p className={problem ? styles.problem : undefined}>{state.detail}</p>}
      {state.phase === 'error' && track.audioReady && <p>Предыдущий файл доступен.</p>}
      {(problem || selected && !state.locked) && <div className={styles.fileActions}>
        {problem && onRetry && <Button type="button" onClick={onRetry}>{state.phase === 'unknown' ? 'Проверить ещё раз' : 'Повторить загрузку'}</Button>}
        {selected && !state.locked && <Button variant="dangerText" type="button" aria-label={`Отменить выбор файла трека ${index + 1}`}
          onClick={() => { const { file: _file, ...rest } = track; void _file; onChange(rest); }}>{track.existingFileName ? 'Отменить замену' : 'Убрать файл'}</Button>}
      </div>}
    </div>
  </div>;
}

/** Общая форма приложения и stories; сетевой сценарий передаётся через onSave. */
export function CreateSong({ initialFilled = false, initialSong, onSave, onCancel, live = false, busy = false, status, error, trackStates, onRetryFile, onFileChange, publication, audioReady, canListen, onListen, onPublish }: CreateSongProps) {
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
    return saved ? { ...track, ...(saved.id ? { id: saved.id } : {}), ...(saved.existingFileName ? { existingFileName: saved.existingFileName } : {}), ...(saved.audioReady !== undefined ? { audioReady: saved.audioReady } : {}) } : track;
  });
  const selected = visibleTracks.filter((track) => track.file || track.existingFileName).length;

  const states = visibleTracks.map((track, index) => fileState(track, trackStates?.[index]));
  const newFiles = visibleTracks.flatMap((track, index) => track.file ? [states[index]!] : []);
  const ready = newFiles.filter(state => state.phase === 'ready').length;
  const started = newFiles.some(state => state.phase !== 'selected');
  const problems = states.filter(state => state.phase === 'error' || state.phase === 'unknown').length;
  const firstProblem = states.findIndex(state => state.phase === 'error' || state.phase === 'unknown');
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
        <div className={styles.uploadSummary}>
          <p role="status" aria-atomic="true">{newFiles.length ? started ? `Файлы: готово ${ready} из ${newFiles.length}` : `Выбрано новых файлов: ${newFiles.length}` : `Готовых партий: ${states.filter(state => state.phase === 'ready').length} из ${count}`}</p>
          {newFiles.length > 0 && (started ? <progress className={styles.progress} max={newFiles.length} value={ready} aria-label="Готовность новых файлов" /> : <p>Загрузка начнётся после сохранения.</p>)}
          {problems > 0 && <div className={styles.summaryProblem}><span>Требуют внимания: {problems}</span><Button type="button" variant="text" onClick={() => document.getElementById(`${id}-track-${firstProblem}`)?.focus()}>К проблеме</Button></div>}
        </div>
        <div className={styles.trackList}>
          {visibleTracks.map((track, index) => <TrackRow key={index} rowId={`${id}-track-${index}`} state={states[index]!} index={index} track={track}
            onRetry={onRetryFile && (track.file || states[index]?.phase === 'unknown') ? () => onRetryFile(index, track.file) : undefined} onChange={(updated) => {
            if (updated.file !== track.file) onFileChange?.(index);
            setTracks((current) => current.map((item, position) => position === index ? updated : item)); setMessage(''); setDirty(true);
          }} />)}
        </div>
        <details className={styles.formats}><summary>Какие файлы можно добавить?</summary>
          <p>Можно выбрать MP3, WAV, FLAC, M4A/AAC, OGG/Opus и другие аудиоформаты. Совместимость проверяется при загрузке.</p>
          <p>Файл преобразуется для воспроизведения, а оригинал удаляется после успешной обработки. Храните исходники у себя.</p>
        </details>
      </section>
      <label className={styles.field}>Заметки <span className={styles.optional}>необязательно</span>
        <Textarea id={`${id}-notes`} name="notes" rows={4} value={notes} placeholder="Вступления, дыхание, сложные места…"
          aria-describedby={`${id}-notes-count`} onChange={(event) => setNotes(event.target.value)} />
      </label>
      <div className={styles.counter} id={`${id}-notes-count`}>{[...notes.normalize('NFC')].length} / 1000</div>
      {message && <Message tone="info" variant="banner" className={styles.message} role="status">{message}</Message>}
      {status && <Message tone="muted" role="status">{status}</Message>}
      {error && <Message tone="error" role="alert">{error}</Message>}
      <div className={styles.actions}>
      <Button variant="primary" size="form" className={styles.submit} type="submit">{busy ? status || 'Сохраняем…' : initialSong ? 'Сохранить изменения' : 'Создать песню'}</Button>
      {onCancel && <Button className={styles.cancel} type="button" onClick={() => { if (!live || !dirty || window.confirm('Отменить несохранённые изменения? Сохранённый черновик останется на сервере.')) { leaving.current = true; onCancel(); } }}>Отмена</Button>}
      {onListen && <Button className={styles.cancel} type="button" disabled={!canListen} onClick={onListen}>Слушать песню</Button>}
      {publication && <p className={styles.help}>Публикация сохранённой версии: {publication === 'published' ? 'опубликована' : 'черновик'}. {audioReady ? 'Аудио готово.' : 'Есть неготовые дорожки.'}</p>}
      {onPublish && <Button className={styles.cancel} type="button" onClick={onPublish}>{publication === 'draft' ? 'Опубликовать сохранённую песню' : 'Снять публикацию'}</Button>}
      </div>
      </fieldset>
      {!live && <p className={styles.demo}>Демо: файлы остаются на устройстве и не загружаются на сервер.</p>}
    </form>
  </main>;
}
