import { useEffect, useState } from 'react';
import { readPublic } from './api/public';
import type { PublicSong } from './api/public';
import { SongLibrary } from './components/SongLibrary/SongLibrary';
import { appUrl } from './navigation/appUrl';
import styles from './components/SongLibrary/SongLibrary.module.css';

/** Public metadata only. Audio playback is integrated separately in Issue #11. */
export function PublicRoute({ token, songId, single }: { token: string; songId: string | null; single: boolean }) {
  const [result, setResult] = useState<{ songs: PublicSong[]; error: boolean } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void readPublic(token, controller.signal).then(
      (songs) => { if (!controller.signal.aborted) setResult({ songs, error: false }); },
      () => { if (!controller.signal.aborted) setResult({ songs: [], error: true }); },
    );
    return () => controller.abort();
  }, [token]);
  if (!result) return <p role="status">Загрузка песни…</p>;
  if (result.error) return <p role="alert">Не удалось открыть ссылку. Она может быть отозвана или сервер недоступен. Обновите страницу для повтора.</p>;
  if (single || songId) {
    const song = single ? result.songs[0] : result.songs.find((s) => s.id === songId);
    if (!song) return <p role="alert">Песня недоступна по этой ссылке.</p>;
    return <main className={styles.page}><div className={styles.content}>
      <h1>{song.title}</h1><p>{song.bpm} BPM · {song.beatsPerBar}/{song.beatUnit}</p>
      <ul>{song.tracks.map((track) => <li key={track.id}>{track.name}</li>)}</ul>
      <p>{song.notes}</p><p role="status">Воспроизведение ещё не подключено.</p>
      {!single && <a href={appUrl(`?list=${encodeURIComponent(token)}`)}>Песни</a>}
    </div></main>;
  }
  return <SongLibrary role="guest" songs={result.songs.map((s, index) => ({
    id: s.id, title: s.title, bpm: s.bpm, meter: `${s.beatsPerBar}/${s.beatUnit}`,
    tracks: s.tracks.length, bars: 4, owner: '', updatedAt: String(result.songs.length - index).padStart(10, '0'), shared: true,
  }))} songHref={(id) => appUrl(`?list=${encodeURIComponent(token)}&id=${encodeURIComponent(id)}`)} />;
}
