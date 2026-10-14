import { useEffect, useId, useState } from 'react';
import type { CSSProperties } from 'react';
import { TrackControls } from '../TrackControls/TrackControls';
import type { TrackTone } from '../TrackControls/TrackControls';
import { barDuration, duration, formatTime, mockScore, mockTracks } from './mockScore';
import type { MockTrack } from './mockScore';
import { PlayerIcon } from './PlayerIcon';
import styles from './RehearsalPlayer.module.css';

export interface RehearsalPlayerProps {
  /** Начальная позиция демонстрационного курсора в секундах. */
  initialTime?: number;
  /** Запускает только визуальное воспроизведение, без аудио. */
  initialPlaying?: boolean;
  /** Повторяет демонстрационный фрагмент: такты 2 и 3. */
  initialLoop?: boolean;
}

/** Мобильный макет репетиции. Приложение и Storybook используют этот же компонент. */
export function RehearsalPlayer({ initialTime = 0, initialPlaying = false, initialLoop = false }: RehearsalPlayerProps) {
  const positionId = useId();
  const [tracks, setTracks] = useState(mockTracks);
  const [time, setTime] = useState(() => Math.min(duration, Math.max(0, initialTime)));
  const [playing, setPlaying] = useState(initialPlaying);
  const [loop, setLoop] = useState(initialLoop);
  const [metronome, setMetronome] = useState(false);
  const isPlaying = playing && time < duration;
  const loopStart = barDuration;
  const loopEnd = barDuration * 3;
  const hasSolo = tracks.some((track) => track.solo);
  const currentBeat = Math.floor(time * mockScore.bpm / 60) % mockScore.beatsPerBar;

  useEffect(() => {
    if (!isPlaying) return;
    let previous = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const elapsed = (now - previous) / 1000;
      previous = now;
      setTime((current) => {
        const next = current + elapsed;
        if (loop && next >= loopEnd) return loopStart + (next - loopEnd) % (loopEnd - loopStart);
        return Math.min(next, duration);
      });
    }, 50);
    return () => window.clearInterval(timer);
  }, [isPlaying, loop, loopEnd, loopStart]);

  function updateTrack(id: TrackTone, patch: Partial<Pick<MockTrack, 'volume' | 'muted' | 'solo'>>) {
    setTracks((current) => current.map((track) => track.id === id ? { ...track, ...patch } : track));
  }

  function togglePlayback() {
    if (!isPlaying && time >= duration) setTime(0);
    setPlaying(!isPlaying);
  }

  const gridStyle = {
    '--bars': mockScore.bars,
    '--beats': mockScore.bars * mockScore.beatsPerBar,
    '--position': `${time / duration * 100}%`,
  } as CSSProperties;

  return (
    <main className={styles.shell}>
      <header className={styles.brand}>
        <span className={styles.brandIcon}><PlayerIcon name="music" /></span>
        <span>Хор<span className={styles.brandCaption}>пространство для репетиций</span></span>
        <span className={styles.demoBadge}>Демо</span>
      </header>

      <section className={styles.player} aria-label="Плеер репетиции">
        <header className={styles.scoreHeader}>
          <p className={styles.eyebrow}>Моя репетиция</p>
          <h1 className={styles.title}>{mockScore.title}</h1>
          <div className={styles.metadata}>
            <span className={styles.pill}>{mockScore.bpm} BPM</span>
            <span className={styles.pill}>{mockScore.beatsPerBar}/4</span>
            <span className={styles.subtitle}>{mockScore.subtitle}</span>
          </div>
        </header>

        <div className={styles.transport} aria-label="Управление воспроизведением">
          <div className={styles.playback}>
            <button className={styles.iconButton} type="button" aria-label="Вернуться к началу" title="Вернуться к началу" onClick={() => setTime(0)}>
              <PlayerIcon name="restart" />
            </button>
            <button className={styles.playButton} type="button" aria-label={isPlaying ? 'Пауза' : 'Воспроизвести'} title={isPlaying ? 'Пауза' : 'Воспроизвести'} onClick={togglePlayback}>
              <PlayerIcon name={isPlaying ? 'pause' : 'play'} />
            </button>
            <span className={styles.time} aria-label={`${formatTime(time)} из ${formatTime(duration)}`}>
              {formatTime(time)} <span>/ {formatTime(duration)}</span>
            </span>
          </div>
          <div className={styles.options}>
            <button className={styles.optionButton} type="button" aria-label="Повтор фрагмента" aria-pressed={loop} title="Повторить такты 2–3" onClick={() => setLoop(!loop)}>
              <PlayerIcon name="loop" /><span>Повтор</span>
            </button>
            <button className={styles.optionButton} type="button" aria-label="Метроном" aria-pressed={metronome} title="Визуальный метроном" onClick={() => setMetronome(!metronome)}>
              <PlayerIcon name="metronome" /><span>Метроном</span>
            </button>
          </div>
          <div className={styles.transportStatus}>
            <span>{loop ? 'Повтор: такты 2–3' : 'Все партии · 4 такта'}</span>
            {metronome && <span className={styles.beats} aria-label="Визуальный метроном">
              {Array.from({ length: mockScore.beatsPerBar }, (_, index) => <i key={index} data-active={isPlaying && index === currentBeat} />)}
            </span>}
          </div>
        </div>

        <section className={styles.timeline} style={gridStyle} aria-label="Общий таймлайн партий">
          <div className={styles.barNumbers} aria-hidden="true">
            {Array.from({ length: mockScore.bars }, (_, index) => <span key={index}>{index + 1}</span>)}
          </div>
          <div className={styles.waveStack}>
            <svg className={styles.waves} viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">
              {tracks.map((track) => {
                const quiet = track.muted || track.volume === 0 || (hasSolo && !track.solo);
                const upper = track.waveform.map((height, index) => `${index / (track.waveform.length - 1) * 1000},${50 - height * 0.46}`).join(' ');
                const lower = track.waveform.map((height, index) => `${index / (track.waveform.length - 1) * 1000},${50 + height * 0.46}`).reverse().join(' ');
                return <polygon key={track.id} points={`${upper} ${lower}`} data-quiet={quiet}
                  style={{ '--wave-color': `var(--color-${track.id})` } as CSSProperties}
                  vectorEffect="non-scaling-stroke" />;
              })}
            </svg>
            {loop && <div className={styles.loopRegion} aria-hidden="true" />}
            <div className={styles.cursor} aria-hidden="true"><span /></div>
          </div>
          <label className="visually-hidden" htmlFor={positionId}>Позиция воспроизведения</label>
          <input className={styles.seek} id={positionId} type="range" min="0" max={duration} step="0.01" value={time}
            aria-valuetext={`${formatTime(time)} из ${formatTime(duration)}`}
            onChange={(event) => setTime(Number(event.currentTarget.value))} />
        </section>

        <section className={styles.mixerSection} aria-label="Микшер партий">
          <div className={styles.mixerHeading}><h2>Партии</h2><span>Громкость · Solo · Mute</span></div>
          <div className={styles.mixer}>
            {tracks.map((track) => (
              <div className={styles.channel} key={track.id} role="group" aria-label={`Партия: ${track.name}`}>
                <TrackControls
                  name={track.name} volume={track.volume} muted={track.muted} solo={track.solo} tone={track.id}
                  orientation="vertical"
                  onVolumeChange={(volume) => updateTrack(track.id, { volume })}
                  onMuteChange={(muted) => updateTrack(track.id, { muted })}
                  onSoloChange={(solo) => updateTrack(track.id, { solo })}
                />
              </div>
            ))}
          </div>
        </section>

      </section>
      <p className={styles.hint}><strong>S</strong> — слушать выбранные партии <span>·</span> <strong>M</strong> — выключить партию</p>
    </main>
  );
}
