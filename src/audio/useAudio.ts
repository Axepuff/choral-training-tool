import { useEffect, useRef, useState } from 'react';
import { AudioEngine, mediaURL } from './engine';
import { MP4Reader } from './mp4';
import type { AudioSong } from './engine';
export interface Wave { startMs: number; stepMs: number; durationMs: number; points: [number, number][] }
export function useAudio(song: AudioSong | undefined, publicAccess: boolean) {
  const engine = useRef<AudioEngine | null>(null);
  const [states, setStates] = useState<Record<string, string>>({});
  const [waves, setWaves] = useState<Record<string, Wave>>({});
  const [error, setError] = useState('');
  useEffect(() => {
    if (!song) return;
    const abort = new AbortController();
    let context: AudioContext;
    try { context = new AudioContext({ sampleRate: 48000 }); }
    catch { setError('Браузер не смог открыть аудиоустройство. Попробуйте другой браузер.'); return; }
    const audio = new AudioEngine(context, (song.durationMs ?? 0) / 1000);
    engine.current = audio;
    setStates({}); setWaves({}); setError('');
    audio.onError = message => { if (!abort.signal.aborted) setError(message); };
    context.onstatechange = () => { if (context.state !== 'running' && audio.playing) audio.pause(); };
    const status = (id: string, value: string) => { if (!abort.signal.aborted) setStates(s => ({ ...s, [id]: value })); };
    const fetchMedia = async (url: string, headers?: HeadersInit) => {
      const response = await fetch(mediaURL(url), { credentials: publicAccess ? 'omit' : 'same-origin', redirect: 'error', ...(headers ? { headers } : {}), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60000)]) });
      if (!response.ok) throw new Error('Аудио недоступно. Ссылка могла быть отозвана.');
      return response;
    };
    audio.onTrackError = (id, e) => status(id, e instanceof Error ? e.message : 'Ошибка загрузки');
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
    })();
    const hide = () => { if (document.hidden) audio.pause(); };
    document.addEventListener('visibilitychange', hide);
    const stop = () => audio.pause();
    window.addEventListener('pagehide', stop);
    return () => { window.removeEventListener('pagehide', stop); abort.abort(); document.removeEventListener('visibilitychange', hide); audio.dispose(); engine.current = null; };
  }, [song, publicAccess]);
  async function run(action: (audio: AudioEngine) => Promise<void>) {
    const audio = engine.current;
    if (!audio) return;
    try {
      if (!audio.buffers.size && !audio.streams.size) throw new Error('Нет загруженных дорожек');
      await action(audio); setError('');
    } catch (e) { audio.pause(); setError(e instanceof Error ? e.message : 'Не удалось запустить звук. Нажмите воспроизведение ещё раз.'); }
  }
  return { engine, states, waves, error, run };
}
