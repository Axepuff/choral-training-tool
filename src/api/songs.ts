import { api } from './client';
import type { SongFormValue } from '../components/CreateSong/CreateSong';
export interface Song {
  id: string; ownerId: string; title: string; bpm: number; beatsPerBar: number; beatUnit: number;
  notes: string; durationMs: number | null; barCount: number | null; publication: 'draft' | 'published'; ready: boolean; version: number; updatedAt: string;
  tracks: { id: string; name: string; position: number; gain: number; status: string; mediaUrl: string | null; durationMs: number | null; peaksUrl: string | null; sourceName?: string; pendingJobId?: string }[];
}
export const getSong = (id: string) => api.request<Song>(`/songs/${encodeURIComponent(id)}`);
export async function listSongs(q: string, sort: string, signal: AbortSignal) {
  const items: Song[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({ q: q.normalize('NFC').trim(), sort });
    if (cursor) params.set('cursor', cursor);
    const page: { items: Song[]; nextCursor: string | null } = await api.request(`/songs?${params}`, { signal });
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('Некорректная страница списка');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return items;
}
export function writeSong(value: SongFormValue, current: Song | null, key: string, publication = current?.publication ?? 'draft') {
  const body = { title: value.title.normalize('NFC').trim(), bpm: value.bpm, beatsPerBar: value.beatsPerBar,
    beatUnit: value.beatUnit, notes: value.notes.normalize('NFC'), publication,
    tracks: value.tracks.map((t, position) => ({ ...(t.id ? { id: t.id } : {}), name: t.name.normalize('NFC').trim(), position, gain: t.gain ?? 1 })) };
  return api.request<Song>(current ? `/songs/${current.id}` : '/songs', {
    method: current ? 'PUT' : 'POST', body: JSON.stringify(body),
    headers: current ? { 'If-Match': `"${current.version}"` } : { 'Idempotency-Key': key },
  });
}
export function songForm(song: Song): SongFormValue {
  return { ...song, tracks: song.tracks.map(t => ({ id: t.id, name: t.name, gain: t.gain,
    ...((t.mediaUrl || t.sourceName) ? { existingFileName: t.sourceName ?? 'Исходное имя недоступно' } : {}) })) };
}
