export interface LibrarySong {
  id: string;
  title: string;
  bpm: number;
  meter: string;
  tracks: number;
  bars: 4 | 16;
  owner: string;
  updatedAt: string;
  shared: boolean;
}

/** Демонстрационные записи. Аудио для них не загружается. */
export const mockSongs: LibrarySong[] = [
  { id: 'quiet-evening', title: 'Тихий вечер', bpm: 84, meter: '4/4', tracks: 5, bars: 16, owner: 'Преподаватель', updatedAt: '2026-10-17', shared: true },
  { id: 'morning', title: 'Утро', bpm: 84, meter: '4/4', tracks: 5, bars: 4, owner: 'Преподаватель', updatedAt: '2026-10-15', shared: false },
  { id: 'road-home', title: 'Дорога домой', bpm: 84, meter: '4/4', tracks: 5, bars: 16, owner: 'Преподаватель', updatedAt: '2026-10-12', shared: true },
  { id: 'spring', title: 'Весенняя песня', bpm: 84, meter: '4/4', tracks: 5, bars: 4, owner: 'Администратор', updatedAt: '2026-10-10', shared: false },
];
