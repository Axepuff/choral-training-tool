import { Message } from '../ui/Message';
import { Button } from '../ui/Button';
import { useEffect, useRef, useState } from 'react';
import type { User } from '../../api/client';
import { ApiError } from '../../api/client';
import { getSong, listSongs, songForm, writeSong } from '../../api/songs';
import type { Song } from '../../api/songs';
import { getJob, uploadFile } from '../../api/uploads';
import { listShareOwners, sharingService } from '../../api/shares';
import { ShareActions } from '../Sharing/ShareActions';
import { Select } from '../ui/Select';
import { CreateSong } from '../CreateSong/CreateSong';
import type { SongFormValue } from '../CreateSong/CreateSong';
import { RehearsalPlayer } from '../RehearsalPlayer/RehearsalPlayer';
import { SongLibrary } from './SongLibrary';
import styles from './SongLibrary.module.css';
const message = (e: unknown) => e instanceof ApiError && ['version_conflict', 'precondition_failed'].includes(e.problem.code)
  ? 'Песня изменена на сервере. Ваши поля сохранены в форме. Сверьте данные и повторите сохранение.'
  : e instanceof Error ? e.message : 'Не удалось выполнить запрос.';

function SongEditor({ id, close, user }: { id: string | null; close: () => void; user: User }) {
  const [listen, setListen] = useState(() => new URLSearchParams(window.location.search).get("play") === "1");
  const [song, setSong] = useState<Song | null>(null);
  const [loaded, setLoaded] = useState(!id);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const key = useRef(crypto.randomUUID());
  const creation = useRef<SongFormValue | null>(null);
  const attempts = useRef(new Map<File, string>());
  const assigned = useRef<string[]>([]);
  const completed = useRef(new Set<File>());
  useEffect(() => { if (!id) return; let active = true; void getSong(id).then(s => { if (active) { setSong(s); setLoaded(true); } }, e => { if (active) setError(message(e)); }); return () => { active = false; }; }, [id]);
  const currentId = song?.id;
  const [uploadJobs, setUploadJobs] = useState<Record<number, string>>({});
  const pending = JSON.stringify(song?.tracks.map((t, index) => t.pendingJobId ?? uploadJobs[index] ?? null) ?? []);
  const [uploadStates, setUploadStates] = useState<Record<number, string>>({});
  const [jobs, setJobs] = useState<Record<string, string>>({});
  useEffect(() => {
    const jobIds = JSON.parse(pending) as (string | null)[];
    if (!currentId || !jobIds.some(Boolean) || busy) return;
    let active = true;
    let timer: number;
    async function check() {
      try {
        const results = await Promise.all(jobIds.filter((id): id is string => !!id).map(async id => [id, (await getJob(id)).state] as const));
        if (!active) return;
        setJobs(Object.fromEntries(results));
        // A confirmed job state supersedes a transient upload/status request error.
        setUploadStates(states => Object.fromEntries(Object.entries(states).filter(([index]) => !results.some(([id]) => jobIds[Number(index)] === id))));
        if (results.some(([, state]) => state === 'succeeded')) setSong(await getSong(currentId!));
        if (results.some(([, state]) => state === 'queued' || state === 'processing')) timer = window.setTimeout(() => void check(), 1500);
      } catch (e) { if (active) setError(message(e)); }
    }
    void check();
    return () => { active = false; window.clearTimeout(timer); };
  }, [currentId, pending, busy]);
  async function save(value: SongFormValue) {
    if (busy) return;
    setBusy(true); setError(''); setUploadStates({}); setUploadJobs({}); setStatus('Сохраняем данные…');
    let current = song;
    let uploadingIndex: number | undefined;
    try {
      const recovering = creation.current !== null;
      const updating = current !== null;
      if (!current) {
        // An unknown POST outcome must be replayed with its original body/key.
        // Keep the mounted form's newer fields and File objects for the PUT/upload.
        creation.current ??= { ...value, tracks: value.tracks.map(t => ({ ...t })) };
        try { current = await writeSong(creation.current, null, key.current); }
        catch (e) {
          if (e instanceof ApiError && [400, 422].includes(e.status)) creation.current = null;
          throw e;
        }
        assigned.current = current.tracks.map(t => t.id); setSong(current);
        creation.current = null;
      }
      if (updating || recovering) {
        const writing = { ...value, tracks: value.tracks.map((t, index) => ({ ...t, ...(!t.id && assigned.current[index] ? { id: assigned.current[index] } : {}) })) };
        current = await writeSong(writing, current, key.current);
      }
      assigned.current = current.tracks.map(t => t.id); setSong(current);
      if (!id) window.history.replaceState(null, '', `?page=edit-song&id=${current.id}`);
      for (const [index, track] of value.tracks.entries()) {
        if (!track.file || completed.current.has(track.file)) continue;
        uploadingIndex = index;
        const target = current.tracks[index]!;
        const file = track.file;
        let uploadKey = attempts.current.get(file);
        if (!uploadKey) { uploadKey = crypto.randomUUID(); attempts.current.set(file, uploadKey); }
        setUploadStates(s => ({ ...s, [index]: 'Загрузка 0%' }));
        let job;
        try {
          job = await uploadFile(current.id, target.id, current.version, file, uploadKey, p => setUploadStates(s => ({ ...s, [index]: `Загрузка ${p}%` })));
        } catch (e) {
          // A final probe rejection is replayed by the server for this key.
          // Keep the key when the network outcome is unknown to avoid duplicate jobs.
          if (e instanceof ApiError && e.status === 422 && ['corrupt_audio', 'unsupported_codec', 'too_long', 'probe_timeout'].includes(e.problem.code)) attempts.current.delete(file);
          throw e;
        }
        const jobId = job.id;
        setUploadJobs(jobs => ({ ...jobs, [index]: jobId }));
        while (job.state === 'queued' || job.state === 'processing') {
          setUploadStates(s => ({ ...s, [index]: 'Обработка…' }));
          await new Promise(resolve => window.setTimeout(resolve, 1000));
          job = await getJob(job.id);
        }
        if (job.state !== 'succeeded') { attempts.current.delete(file); throw new Error(`${track.name}: ${job.errorCode ?? job.state}. Выберите другой файл или повторите сохранение. ${target.mediaUrl ? 'Старая готовая дорожка сохранена.' : 'Дорожка ещё не готова.'}`); }
        setUploadStates(s => ({ ...s, [index]: 'Готово' }));
        completed.current.add(file);
        current = await getSong(current.id); setSong(current);
        uploadingIndex = undefined;
      }
      current = await getSong(current.id); setSong(current);
      setEpoch(e => e + 1);
      setStatus('Изменения сохранены на сервере.');
    } catch (e) {
      setError(message(e)); setStatus('');
      if (uploadingIndex !== undefined) { const index = uploadingIndex; setUploadStates(s => ({ ...s, [index]: message(e) })); }
      // Refresh only concurrency metadata: leave the user's fields/files mounted.
      if (current) { try { setSong(await getSong(current.id)); } catch { /* Keep original failure visible. */ } }
    } finally { setBusy(false); }
  }
  if (!loaded) return <main className={styles.page}>{error ? <Message tone="error" role="alert">{error}</Message> : <Message tone="muted" role="status">Загрузка песни…</Message>}<Button className={styles.shareAction} onClick={close}>Песни</Button></main>;
  if (song && (listen || (user.role !== 'admin' && song.ownerId !== user.id))) return <>
    <RehearsalPlayer key={song.id} song={song} />{(user.role === "admin" || song.ownerId === user.id) && <Button className={styles.shareAction} onClick={() => setListen(false)}>К редактированию</Button>}<Button className={styles.shareAction} onClick={close}>Песни</Button>
  </>;
  return <>
    <CreateSong key={epoch} live busy={busy} status={status} error={error} {...(song ? { initialSong: songForm(song) } : {})} onSave={save} onCancel={close}
      trackStates={song?.tracks.map((t, index) => uploadStates[index] ?? (t.pendingJobId && jobs[t.pendingJobId] === 'failed' ? 'Ошибка обработки. Сохранённый файл не изменён.' : t.pendingJobId && ['queued', 'processing'].includes(jobs[t.pendingJobId] ?? '') ? 'Обработка…' : t.status === 'ready' ? 'Готово' : t.status === 'failed' ? 'Ошибка обработки — повторите или замените файл' : t.status === 'empty' ? 'Файл не загружен' : 'Обработка…'))}
      publication={song?.publication} audioReady={song?.ready} canListen={song?.tracks.some(t => !!t.mediaUrl)}
      onListen={song ? () => setListen(true) : undefined}
      onPublish={song ? async () => {
        setBusy(true); setError(''); setStatus('Обновляем публикацию…');
        try { const updated = await writeSong(songForm(song), song, key.current, song.publication === 'draft' ? 'published' : 'draft'); setSong(updated); setStatus('Публикация обновлена.'); }
        catch (e) {
          setStatus(''); setError(message(e));
          if (e instanceof ApiError && ['version_conflict', 'precondition_failed'].includes(e.problem.code)) {
            // Do not remount the form: unsaved fields and files belong to the user.
            try { setSong(await getSong(song.id)); } catch { /* Keep the conflict visible. */ }
          }
        } finally { setBusy(false); }
      } : undefined} />
  </>;
}

export function LiveLibrary({ user, create, editId }: { user: User; create: boolean; editId: string | null }) {
  const [songs, setSongs] = useState<Song[]>([]);
  const [filter, setFilter] = useState({ q: '', sort: 'updated_desc' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [owners, setOwners] = useState<User[]>([]);
  const [ownerId, setOwnerId] = useState('');
  const [ownersError, setOwnersError] = useState('');
  const [ownersRetry, setOwnersRetry] = useState(0);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (user.role !== 'admin') return;
    const abort = new AbortController();
    void listShareOwners(abort.signal).then(result => {
      if (!abort.signal.aborted) { setOwners(result); setOwnersError(''); }
    }, failure => { if (!abort.signal.aborted) setOwnersError(message(failure)); });
    return () => abort.abort();
  }, [user.role, ownersRetry]);
  useEffect(() => {
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true); setError('');
      void listSongs(filter.q, filter.sort, abort.signal).then(r => { if (!abort.signal.aborted) setSongs(r); }, e => { if (!abort.signal.aborted) setError(message(e)); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    }, 200);
    return () => { window.clearTimeout(timer); abort.abort(); };
  }, [filter, retry]);
  if (create || editId) return <SongEditor user={user} id={editId} close={() => { window.location.href = '?page=library'; }} />;
  const owner = user.role === 'teacher' ? user : owners.find(account => account.id === ownerId);
  const ownerLabel = (id: string) => id === user.id ? user.email : owners.find(account => account.id === id)?.email;
  const edit = (id: string) => { window.location.href = `?page=edit-song&id=${id}`; };
  return <>
    <SongLibrary role={user.role} songs={songs.map(s => ({ id: s.id, title: s.title, bpm: s.bpm, meter: `${s.beatsPerBar}/${s.beatUnit}`, tracks: s.tracks.length, bars: 4, owner: ownerLabel(s.ownerId) ?? 'Загрузка владельца…', updatedAt: s.updatedAt, shared: s.publication === 'published' && s.ready }))}
      shareActions={<>
        {user.role === 'admin' && <label className={styles.shareOwner}>Чей репертуар передать
          <Select name="shareOwner" value={ownerId} disabled={!owners.length} onChange={event => setOwnerId(event.target.value)}>
            <option value="">{ownersError ? 'Не удалось загрузить преподавателей' : owners.length ? 'Выберите преподавателя' : 'Загрузка преподавателей…'}</option>
            {owners.map(account => <option key={account.id} value={account.id}>{account.email}{account.id === user.id ? ' · ваш репертуар' : ''}{account.blocked ? ' · вход заблокирован' : ''}</option>)}
          </Select>
        </label>}
        {ownersError && <><Message tone="error" role="alert">{ownersError}</Message><Button onClick={() => setOwnersRetry(value => value + 1)}>Повторить загрузку преподавателей</Button></>}
        <ShareActions key={owner?.id ?? 'unselected'} kind="list" service={sharingService} target={owner ? { scope: { kind: 'list', ownerId: owner.id }, ownerLabel: owner.email, empty: !loading && !error && !filter.q.trim() && !songs.some(song => song.ownerId === owner.id && song.publication === 'published' && song.ready) } : null} />
      </>}
      songActions={librarySong => {
        const song = songs.find(item => item.id === librarySong.id)!;
        const label = ownerLabel(song.ownerId);
        return <ShareActions key={song.id} kind="song" service={sharingService} disabled={!label} target={{ scope: { kind: 'song', songId: song.id }, ownerLabel: label ?? '', title: song.title,
          unavailable: !song.ready ? 'Дождитесь обработки всех партий или исправьте ошибки в редакторе.' : song.publication !== 'published' ? 'Сначала опубликуйте её в редакторе.' : undefined,
          onEdit: () => edit(song.id),
        }} />;
      }}
      loading={loading} error={error} songHref={id => `?page=edit-song&id=${id}&play=1`} live={{
        canEdit: s => user.role === 'admin' || songs.find(song => song.id === s.id)?.ownerId === user.id,
        onEdit: edit,
        onFilter: (q, sort) => setFilter({ q, sort: sort === 'title' ? 'title_asc' : 'updated_desc' }),
      }} />
    {error && <Button onClick={() => setRetry(r => r + 1)}>Повторить загрузку</Button>}
  </>;
}
