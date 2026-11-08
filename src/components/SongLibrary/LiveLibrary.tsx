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
import type { SongFormValue, TrackUploadState } from '../CreateSong/CreateSong';
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
  const attempts = useRef(new Map<string, { file: File; key: string; jobId?: string; done?: boolean }>());
  const assigned = useRef<string[]>([]);

  useEffect(() => { if (!id) return; let active = true; void getSong(id).then(s => { if (active) { setSong(s); setLoaded(true); } }, e => { if (active) setError(message(e)); }); return () => { active = false; }; }, [id]);
  const currentId = song?.id;
  const [uploadStates, setUploadStates] = useState<Record<string, TrackUploadState>>({});
  const pending = JSON.stringify(song?.tracks.flatMap(t => {
    const state = uploadStates[t.id];
    const attempt = attempts.current.get(t.id);
    const jobId = attempt ? attempt.jobId : t.pendingJobId;
    return jobId && state?.phase !== 'ready' && state?.phase !== 'error' ? [[t.id, jobId]] : [];
  }) ?? []);
  useEffect(() => {
    const entries = JSON.parse(pending) as [string, string][];
    if (!currentId || !entries.length || busy) return;
    let active = true;
    let timer: number;
    let failures = 0;
    async function check() {
      let again = false;
      let failed = false;
      await Promise.all(entries.map(async ([trackId, jobId]) => {
        const attempt = attempts.current.get(trackId);
        try {
          const job = await getJob(jobId);
          if (!active) return;
          if (job.state === 'succeeded') {
            const fresh = await getSong(currentId!);
            if (!active) return;
            if (attempt?.jobId === jobId) attempt.done = true;
            setSong(fresh); setStatus('');
            setUploadStates(states => ({ ...states, [trackId]: { phase: 'ready', file: attempt?.file } }));
          } else if (job.state === 'failed' || job.state === 'canceled') {
            setUploadStates(states => ({ ...states, [trackId]: { phase: 'error', file: attempt?.file, detail: attempt ? 'Не удалось подготовить аудио. Выберите другой файл или повторите загрузку.' : 'Не удалось подготовить аудио. Выберите файл на устройстве, чтобы загрузить его снова.' } }));
          } else {
            again = true;
            setUploadStates(states => ({ ...states, [trackId]: { phase: job.state === 'queued' ? 'queued' : 'processing', file: attempt?.file, locked: true } }));
          }
        } catch (e) {
          if (!active) return;
          failed = true;
          if (!(e instanceof ApiError && [401, 403, 404].includes(e.status))) again = true;
          setUploadStates(states => ({ ...states, [trackId]: { phase: 'unknown', file: attempt?.file, locked: true, detail: message(e) } }));
        }
      }));
      failures = failed ? failures + 1 : 0;
      if (active && again && failures < 3) timer = window.setTimeout(() => void check(), 1500);
    }
    void check();
    return () => { active = false; window.clearTimeout(timer); };
  }, [currentId, pending, busy]);

  async function transfer(songId: string, trackId: string, file?: File): Promise<boolean> {
    let attempt = attempts.current.get(trackId);
    if (file && (attempt?.file !== file || uploadStates[trackId]?.phase === 'error')) {
      attempt = { file, key: crypto.randomUUID() }; attempts.current.set(trackId, attempt);
    }
    if (attempt?.done) return true;
    const update = (state: TrackUploadState) => setUploadStates(states => ({ ...states, [trackId]: { ...state, file: attempt?.file } }));
    let accepted = !!attempt?.jobId;
    try {
      const fresh = await getSong(songId); setSong(fresh);
      const target = fresh.tracks.find(t => t.id === trackId);
      if (!target) throw new Error('Партия удалена на сервере. Откройте песню заново.');
      let job;
      if (attempt?.jobId) job = await getJob(attempt.jobId);
      else if (attempt) {
        update({ phase: 'uploading', locked: true }); setStatus('Загружаем файлы…');
        job = await uploadFile(songId, trackId, fresh.version, attempt.file, attempt.key, progress => update({ phase: 'uploading', progress, locked: true }));
        attempt.jobId = job.id; accepted = true;
      } else if (target.pendingJobId) { job = await getJob(target.pendingJobId); accepted = true; }
      else {
        update({ phase: target.mediaUrl ? 'ready' : target.status === 'failed' ? 'error' : 'empty', detail: target.mediaUrl ? undefined : 'Выберите файл на устройстве, чтобы загрузить его.' });
        return !!target.mediaUrl;
      }
      while (job.state === 'queued' || job.state === 'processing') {
        update({ phase: job.state, locked: true }); setStatus('Подготавливаем аудио…');
        await new Promise(resolve => window.setTimeout(resolve, 1000));
        job = await getJob(job.id);
      }
      if (job.state !== 'succeeded') {
        update({ phase: 'error', detail: attempt ? 'Не удалось подготовить аудио. Выберите другой файл или повторите загрузку.' : 'Не удалось подготовить аудио. Выберите файл на устройстве, чтобы загрузить его снова.' });
        return false;
      }
      const updated = await getSong(songId); setSong(updated);
      if (attempt) attempt.done = true;
      update({ phase: 'ready' });
      return true;
    } catch (e) {
      // No response (including a 5xx proxy response) cannot prove rejection.
      const rejected = !accepted && e instanceof ApiError && e.status >= 400 && e.status < 500;
      update({ phase: rejected ? 'error' : 'unknown', locked: !rejected, detail: message(e) });
      try { setSong(await getSong(songId)); } catch { /* Keep the unresolved outcome visible. */ }
      return false;
    }
  }
  async function retryFile(index: number, file?: File) {
    if (busy || !song) return;
    const track = song.tracks[index];
    if (!track) return;
    setBusy(true); setStatus('Проверяем результат…');
    try { await transfer(song.id, track.id, file); }
    finally { setStatus(''); setBusy(false); }
  }
  async function save(value: SongFormValue) {
    if (busy) return;
    setBusy(true); setError(''); setStatus('Сохраняем данные…');
    let current = song;

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
      setUploadStates(states => ({ ...states, ...Object.fromEntries(value.tracks.flatMap((track, index) => track.file && !attempts.current.get(current!.tracks[index]!.id)?.done ? [[current!.tracks[index]!.id, { phase: 'waiting' as const, file: track.file }]] : [])) }));
      let allReady = true;
      for (const [index, track] of value.tracks.entries()) {
        if (track.file && !await transfer(current.id, current.tracks[index]!.id, track.file)) allReady = false;
      }
      current = await getSong(current.id); setSong(current);
      if (!allReady) { setStatus('Данные песни сохранены. Не все файлы готовы — проверьте состояния партий.'); return; }
      setEpoch(e => e + 1);
      setStatus('Изменения сохранены на сервере.');
    } catch (e) {
      setError(message(e)); setStatus('');
      // Refresh only concurrency metadata: leave the user's fields/files mounted.
      if (current) { try { setSong(await getSong(current.id)); } catch { /* Keep original failure visible. */ } }
    } finally { setBusy(false); }
  }
  if (!loaded) return <main className={styles.page}>{error ? <Message tone="error" role="alert">{error}</Message> : <Message tone="muted" role="status">Загрузка песни…</Message>}<Button className={styles.shareAction} onClick={close}>Песни</Button></main>;
  if (song && (listen || (user.role !== 'admin' && song.ownerId !== user.id))) return <RehearsalPlayer key={song.id} song={song} navigation={<>
    {(user.role === "admin" || song.ownerId === user.id) && <Button onClick={() => setListen(false)}>К редактированию</Button>}
    <Button onClick={close}>Песни</Button>
  </>} />;
  return <>
    <CreateSong key={epoch} live busy={busy} status={status} error={error} {...(song ? { initialSong: songForm(song) } : {})} onSave={save} onCancel={close}
      trackStates={song?.tracks.map(t => uploadStates[t.id] ?? { phase: t.pendingJobId ? 'queued' : t.status === 'ready' ? 'ready' : t.status === 'failed' ? 'error' : 'empty', locked: !!t.pendingJobId })}
      onRetryFile={(index, file) => { void retryFile(index, file); }}
      onFileChange={index => {
        const trackId = song?.tracks[index]?.id;
        if (trackId) { attempts.current.delete(trackId); setUploadStates(states => ({ ...states, [trackId]: { phase: song?.tracks[index]?.mediaUrl ? 'ready' : 'empty' } })); }
        setStatus('');
      }}
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
