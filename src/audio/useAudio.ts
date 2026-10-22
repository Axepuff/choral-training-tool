import { useEffect, useRef, useState } from 'react';
import { AudioEngine, mediaURL } from './engine';
import type { AudioSong, Mix } from './engine';
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
    try { context = new AudioContext({ sampleRate: 24000 }); }
    catch { setError('Браузер не смог открыть аудиоустройство. Попробуйте другой браузер.'); return; }
    const audio = new AudioEngine(context, (song.durationMs ?? 0) / 1000);
    engine.current = audio;
    context.onstatechange = () => { if (context.state === 'suspended' && audio.playing) audio.pause(); };
    const status = (id: string, value: string) => { if (!abort.signal.aborted) setStates(s => ({ ...s, [id]: value })); };
    const fetchMedia = async (url: string) => {
      const response = await fetch(mediaURL(url), { credentials: publicAccess ? 'omit' : 'same-origin', redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60000)]) });
      if (!response.ok) throw new Error('Аудио недоступно. Ссылка могла быть отозвана.');
      return response;
    };
    void (async () => {
      let bytes = 0;
      // Sequential decode bounds temporary memory; mono playback is guaranteed by the API.
      for (const track of song.tracks) {
        status(track.id, 'Загрузка…');
        try {
          if (!track.mediaUrl || !track.durationMs) throw new Error('Файл ещё не готов');
          const estimate = Math.ceil(track.durationMs / 1000 * context.sampleRate) * 4;
          if (bytes + estimate > 256 * 1024 * 1024) throw new Error('Лимит памяти аудио (256 MiB). Сократите число или длину дорожек.');
          const buffer = await context.decodeAudioData(await (await fetchMedia(track.mediaUrl)).arrayBuffer());
          if (abort.signal.aborted) return;
          bytes += buffer.length * buffer.numberOfChannels * 4;
          audio.buffers.set(track.id, buffer);
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
  async function run(action: (audio: AudioEngine) => Promise<void>, mix: Record<string, Mix>) {
    const audio = engine.current;
    if (!audio) return;
    try {
      if (!audio.buffers.size) throw new Error('Нет загруженных дорожек');
      await action(audio); audio.setMix(mix); setError('');
    } catch (e) { audio.pause(); setError(e instanceof Error ? e.message : 'Не удалось запустить звук. Нажмите воспроизведение ещё раз.'); }
  }
  return { engine, states, waves, error, run };
}
