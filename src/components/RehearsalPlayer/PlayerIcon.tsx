import { useId } from 'react';

type IconName = 'play' | 'pause' | 'restart' | 'loop' | 'metronome' | 'music';

const paths: Record<IconName, string> = {
  play: 'M9 5l11 7-11 7V5Z',
  pause: 'M9 5v14M15 5v14',
  restart: 'M5 5v14M19 6l-10 6 10 6V6Z',
  loop: 'M5 8h13l-3-3m3 3-3 3M19 16H6l3 3m-3-3 3-3',
  metronome: 'M7 20 10 4h4l3 16H7Zm5-9 6-6M5 20h14',
  music: 'M9 17V5l10-2v12M9 8l10-2M9 17c0 1.7-1.4 3-3 3s-3-1-3-2.5S4.4 15 6 15s3 1 3 2Zm10-2c0 1.7-1.4 3-3 3s-3-1-3-2.5 1.4-2.5 3-2.5 3 1 3 2Z',
};

export function PlayerIcon({ name }: { name: IconName }) {
  const gradientId = useId();
  const isPlayback = name === 'play' || name === 'pause';
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {isPlayback && (
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop stopColor="var(--color-accent)" />
            <stop offset="1" stopColor="color-mix(in srgb, var(--color-accent) 90%, white)" />
          </linearGradient>
        </defs>
      )}
      <path d={paths[name]} fill={name === 'play' ? `url(#${gradientId})` : 'none'} stroke={isPlayback ? `url(#${gradientId})` : 'currentColor'} />
    </svg>
  );
}
