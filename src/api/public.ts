import { api } from './client';
export interface PublicSong {
  id: string; title: string; bpm: number; beatsPerBar: number; beatUnit: number;
  notes: string; barCount: number; durationMs: number;
  tracks: { id: string; name: string; gain: number; durationMs: number; mediaUrl: string; peaksUrl: string }[];
}
interface PublicPage { kind: 'song' | 'list'; songs: PublicSong[]; nextCursor: string | null }
export async function readPublic(token: string, signal: AbortSignal) {
  const songs: PublicSong[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: PublicPage = await api.request(`/public/shares/${encodeURIComponent(token)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { signal }, 'public');
    if (!Array.isArray(page.songs) || !['song', 'list'].includes(page.kind) ||
      (page.nextCursor !== null && typeof page.nextCursor !== 'string')) throw new Error('Некорректный ответ сервера');
    songs.push(...page.songs);
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('Некорректная страница списка');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return songs;
}
