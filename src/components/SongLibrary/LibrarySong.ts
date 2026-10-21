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

