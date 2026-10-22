import { useEffect, useState } from 'react';
import { readPublic } from './api/public';
import type { PublicSong } from './api/public';
import { SongLibrary } from './components/SongLibrary/SongLibrary';
import { appUrl } from './navigation/appUrl';
import { RehearsalPlayer } from './components/RehearsalPlayer/RehearsalPlayer';

/** Public player never sends session cookies for media or peaks. */
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
    return <><RehearsalPlayer key={song.id} song={song} publicAccess />
      {!single && <a href={appUrl(`?list=${encodeURIComponent(token)}`)}>Песни</a>}</>;
  }
  return <SongLibrary role="guest" songs={result.songs.map((s, index) => ({
    id: s.id, title: s.title, bpm: s.bpm, meter: `${s.beatsPerBar}/${s.beatUnit}`,
    tracks: s.tracks.length, bars: 4, owner: '', updatedAt: String(result.songs.length - index).padStart(10, '0'), shared: true,
  }))} songHref={(id) => appUrl(`?list=${encodeURIComponent(token)}&id=${encodeURIComponent(id)}`)} />;
}
