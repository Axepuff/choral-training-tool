import type { TrackTone } from '../TrackControls/TrackControls';

export const mockScore = {
  title: 'Тихий вечер',
  subtitle: 'Учебный фрагмент · 4 такта',
  bpm: 84,
  beatsPerBar: 4,
  bars: 4,
} as const;

export interface MockTrack {
  id: string;
  tone: TrackTone;
  name: string;
  volume: number;
  muted: boolean;
  solo: boolean;
  waveform: number[];
}

const voices = [
  { id: 'soprano', name: 'Сопрано', volume: 80 },
  { id: 'alto', name: 'Альт', volume: 70 },
  { id: 'tenor', name: 'Тенор', volume: 70 },
  { id: 'bass', name: 'Бас', volume: 75 },
  { id: 'backing', name: 'Минус', volume: 55 },
] as const;

/** Детерминированные визуальные заглушки; аудиоданных здесь нет. */
export const mockTracks: MockTrack[] = voices.map((voice, trackIndex) => ({
  ...voice,
  tone: voice.id,
  muted: false,
  solo: false,
  waveform: Array.from({ length: 96 }, (_, index) => {
    const phrase = Math.sin(index / 7 + trackIndex * 1.6) ** 2;
    const texture = Math.abs(Math.sin(index * 2.7 + trackIndex));
    return 12 + phrase * 55 + texture * 22;
  }),
}));

export const duration = mockScore.bars * mockScore.beatsPerBar * 60 / mockScore.bpm;
export const barDuration = mockScore.beatsPerBar * 60 / mockScore.bpm;

export function formatTime(seconds: number) {
  const rounded = Math.max(0, Math.floor(seconds));
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
}
