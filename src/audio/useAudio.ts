import { useEffect, useRef, useState } from 'react';
import { AudioEngine, mediaURL } from './engine';
import { AudioDecodeError, MP4Reader } from './mp4';
import type { AudioDecodeDiagnostics } from './mp4';
import type { AudioSong } from './engine';
export interface Wave { startMs: number; stepMs: number; durationMs: number; points: [number, number][] }
function trackStates(song: AudioSong | undefined, state: string): Record<string, string> {
  return Object.fromEntries((song?.tracks ?? []).map(track => [track.id, state]));
}
export function useAudio(song: AudioSong | undefined, publicAccess: boolean) {
  const engine = useRef<AudioEngine | null>(null);
  const [states, setStates] = useState(() => trackStates(song, 'Загрузка…'));
  const [waves, setWaves] = useState<Record<string, Wave>>({});
  const [error, setError] = useState('');
  const [diagnostics, setDiagnostics] = useState<Record<string, AudioDecodeDiagnostics>>({});
  const [initialization, setInitialization] = useState<'loading' | 'complete' | 'unavailable'>(song ? 'loading' : 'complete');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setStates(trackStates(song, 'Загрузка…')); setWaves({}); setError(''); setDiagnostics({});
    if (!song) { setInitialization('complete'); return; }
    setInitialization('loading');
    const abort = new AbortController();
    let context: AudioContext;
    try { context = new AudioContext({ sampleRate: 48000 }); }
    catch {
      setError('Браузер не смог открыть аудиоустройство. Повторите подключение аудио.');
      setStates(trackStates(song, 'Аудиоустройство недоступно'));
      setInitialization('unavailable');
      return;
    }
    const audio = new AudioEngine(context, (song.durationMs ?? 0) / 1000);
    engine.current = audio;
    audio.onError = message => { if (!abort.signal.aborted) setError(message); };
    context.onstatechange = () => { if (context.state !== 'running' && audio.playing) audio.pause(); };
    const indexed = new Set<string>();
    const status = (id: string, value: string) => {
      if (abort.signal.aborted) return;
      setStates(s => ({ ...s, [id]: value }));
      if (value !== 'Загрузка…') indexed.add(id);
      // Peaks may still be loading after the last audio index is ready.
      if (indexed.size === song.tracks.length) setInitialization('complete');
    };
    const fetchMedia = async (url: string, headers?: HeadersInit) => {
      const response = await fetch(mediaURL(url), { credentials: publicAccess ? 'omit' : 'same-origin', redirect: 'error', ...(headers ? { headers } : {}), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60000)]) });
      if (!response.ok) throw new Error('Аудио недоступно. Ссылка могла быть отозвана.');
      return response;
    };
    audio.onTrackError = (id, e) => {
      status(id, e instanceof Error ? e.message : 'Ошибка загрузки');
      if (!abort.signal.aborted && e instanceof AudioDecodeError) setDiagnostics(current => ({ ...current, [id]: e.diagnostics }));
    };
    void (async () => {
      // Keep only the MP4 index and a small scheduled PCM horizon, independent of song length.
      for (const track of song.tracks) {
        status(track.id, 'Загрузка…');
        try {
          if (!track.mediaUrl || !track.durationMs) throw new Error('Файл ещё не готов');
          let etag: string | null = null;
          const url = track.mediaUrl;
          const reader = await MP4Reader.open(async (start, end) => {
            const response = await fetchMedia(url, { Range: `bytes=${start}-${end}` });
            if (response.status !== 206 || !response.headers.get('Content-Range')?.startsWith(`bytes ${start}-${end}/`)) throw new Error('Сервер не поддерживает загрузку фрагментов аудио');
            const version = response.headers.get('ETag');
            if (!version || (etag && version !== etag)) throw new Error('Аудиофайл изменился. Обновите страницу.');
            etag = version;
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.length !== end - start + 1) throw new Error('Неполный фрагмент аудио');
            return bytes;
          });
          if (abort.signal.aborted) return;
          const duration = track.durationMs / 1000;
          audio.streams.set(track.id, { duration, load: (start, end) => reader.decode(context, start, end) });
          status(track.id, 'Готово');
          if (track.peaksUrl) {
            try {
              const wave: Wave = await (await fetchMedia(track.peaksUrl)).json();
              if (wave.startMs !== 0 || wave.stepMs !== 100 || wave.points.length !== Math.ceil(wave.durationMs / 100) ||
                !wave.points.every(p => p.length === 2 && p.every(n => Number.isFinite(n) && Math.abs(n) <= 1))) throw new Error();
              if (!abort.signal.aborted) setWaves(w => ({ ...w, [track.id]: wave }));
            } catch { status(track.id, 'Готово · волна недоступна'); }
          }
        } catch (e) { status(track.id, e instanceof Error ? e.message : 'Ошибка загрузки'); }
        if (abort.signal.aborted) return;
      }
    })().finally(() => { if (!abort.signal.aborted) setInitialization('complete'); });
    const hide = () => { if (document.hidden) audio.pause(); };
    document.addEventListener('visibilitychange', hide);
    const stop = () => audio.pause();
    window.addEventListener('pagehide', stop);
    return () => { window.removeEventListener('pagehide', stop); abort.abort(); document.removeEventListener('visibilitychange', hide); audio.dispose(); engine.current = null; };
  }, [song, publicAccess, attempt]);
  function retryInitialization() {
    setInitialization('loading');
    setAttempt(value => value + 1);
  }
  async function run(action: (audio: AudioEngine) => Promise<void>) {
    const audio = engine.current;
    if (!audio) return;
    try {
      if (!audio.buffers.size && !audio.streams.size) throw new Error('Нет загруженных дорожек');
      await action(audio); setError('');
    } catch (e) { audio.pause(); setError(e instanceof Error ? e.message : 'Не удалось запустить звук. Нажмите воспроизведение ещё раз.'); }
  }
  return { engine, states, waves, error, diagnostics, run,
    loading: initialization === 'loading', retryRequired: initialization === 'unavailable', retryInitialization };
}
