import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { TrackControls } from '../TrackControls/TrackControls';
import type { TrackTone } from '../TrackControls/TrackControls';
import { barDuration, formatTime, mockScore, mockTracks } from './mockScore';
import { updateMix } from '../../audio/engine';
import type { AudioSong, Mix } from '../../audio/engine';
import { useAudio } from '../../audio/useAudio';
import type { Wave } from '../../audio/useAudio';
import { PlayerIcon } from './PlayerIcon';
import styles from './RehearsalPlayer.module.css';

export interface RehearsalPlayerProps {
  song?: AudioSong;
  publicAccess?: boolean;
  /** Название выбранной песни в демонстрационной библиотеке. */
  pieceTitle?: string;
  /** Длина демонстрационного фрагмента. */
  bars?: 1 | 4 | 16;
  /** Начальная позиция демонстрационного курсора в секундах. */
  initialTime?: number;
  /** Запускает только визуальное воспроизведение, без аудио. */
  initialPlaying?: boolean;
  /** Начальное состояние повтора. */
  initialLoop?: boolean;
  initialLoopRange?: [number, number];
}

/** Мобильный макет репетиции. Приложение и Storybook используют этот же компонент. */
export function RehearsalPlayer({ initialTime = 0, initialPlaying = false, initialLoop = false, initialLoopRange = [1, 1], bars = 4, pieceTitle = mockScore.title, song, publicAccess = false }: RehearsalPlayerProps) {
  const positionId = useId();
  const timelineRef = useRef<HTMLDivElement>(null);
  const bpm = song?.bpm ?? mockScore.bpm;
  const beatsPerBar = song?.beatsPerBar ?? mockScore.beatsPerBar;
  const beatUnit = song?.beatUnit ?? 4;
  const realBarDuration = 60 * beatsPerBar * 4 / (bpm * beatUnit);
  const duration = song ? (song.durationMs ?? 0) / 1000 : bars * barDuration;
  const count = song ? Math.max(1, Math.ceil(duration / realBarDuration)) : bars;
  const barLabel = count % 100 >= 11 && count % 100 <= 14 ? 'тактов' : count % 10 === 1 ? 'такт' : count % 10 >= 2 && count % 10 <= 4 ? 'такта' : 'тактов';
  const audio = useAudio(song, publicAccess);
  const [storedTracks, setTracks] = useState(() => song ? song.tracks.map((t, i) => ({ id: t.id, name: t.name, volume: t.gain * 100, muted: false, solo: false, waveform: [] as number[], tone: (['soprano', 'alto', 'tenor', 'bass', 'backing'] as TrackTone[])[i % 5]! })) : mockTracks.map(t => ({ ...t, tone: t.id })));
  const tracks = useMemo(() => storedTracks.map(track => {
    const status = audio.states[track.id];
    return song && status && status !== 'Загрузка…' && !status.startsWith('Готово')
      ? { ...track, solo: false } : track;
  }), [storedTracks, audio.states, song]);
  const [time, setTime] = useState(() => Math.min(duration, Math.max(0, initialTime)));
  const [playing, setPlaying] = useState(initialPlaying);
  const [pendingPlayback, setPendingPlayback] = useState(false);
  const [loop, setLoop] = useState(initialLoop);
  const rangeId = useId();
  const [range, setRange] = useState(initialLoopRange);
  const validRange = range.every(Number.isInteger) && range[0] >= 1 && range[1] <= count && range[0] <= range[1];
  const [loopError, setLoopError] = useState('');
  const [metronome, setMetronome] = useState(false);
  const isPlaying = playing && time < duration;
  const playbackLoading = audio.loading || (pendingPlayback && !audio.retryRequired);
  const playbackLabel = playbackLoading ? 'Загрузка аудио' : audio.retryRequired ? 'Повторить подключение аудио' : isPlaying ? 'Пауза' : 'Воспроизвести';
  const mix = Object.fromEntries(tracks.map(t => [t.id, t]));
  const loopStart = (range[0] - 1) * realBarDuration;
  const loopEnd = Math.min(duration, realBarDuration * range[1]);
  const activeLoop = loop && validRange && loopEnd > loopStart;
  const hasSolo = tracks.some((track) => track.solo);
  const currentBeat = Math.floor(time * bpm * beatUnit / 240) % beatsPerBar;

  useEffect(() => {
    if (song) {
      let frame: number, lastUpdate = -Infinity;
      const tick = (now: number) => {
        const engine = audio.engine.current;
        // Read the audio clock at 20 Hz without reconciling a long score on
        // every display frame; audio scheduling keeps its own clock.
        if (engine && now - lastUpdate >= 50) {
          lastUpdate = now;
          if (engine.playing && engine.position >= duration) engine.pause();
          setTime(engine.position); setPlaying(engine.playing);
          setPendingPlayback(engine.playbackRequested && !engine.playing);
        }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(frame);
    }
    if (!isPlaying) return;
    let previous = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const elapsed = (now - previous) / 1000;
      previous = now;
      setTime((current) => {
        const next = current + elapsed;
        if (activeLoop && next >= loopEnd) return loopStart + (next - loopEnd) % (loopEnd - loopStart);
        return Math.min(next, duration);
      });
    }, 50);
    return () => window.clearInterval(timer);
  }, [isPlaying, activeLoop, loopEnd, loopStart, duration, song, audio.engine]);

  useEffect(() => {
    const viewport = timelineRef.current;
    if (!viewport) return;
    const cursor = time / (duration || 1) * viewport.scrollWidth;
    if (cursor < viewport.scrollLeft || cursor > viewport.scrollLeft + viewport.clientWidth - 12) {
      viewport.scrollLeft = Math.max(0, cursor - viewport.clientWidth / 4);
    }
  }, [time, duration]);

  useEffect(() => {
    audio.engine.current?.setMix(Object.fromEntries(tracks.map(t => [t.id, t])));
  }, [tracks, audio.engine]);

  useEffect(() => {
    if (!song) {
      if (activeLoop) setTime(value => value < loopStart || value >= loopEnd ? loopStart : value);
      return;
    }
    if (audio.loading) return;
    setLoopError('');
    const engine = audio.engine.current;
    void engine?.setLoop(activeLoop ? { start: loopStart, end: loopEnd } : null)
      .catch(error => { engine.pause(); setLoopError(error instanceof Error ? error.message : 'Не удалось изменить повтор'); });
  }, [song, audio.loading, audio.engine, activeLoop, loopStart, loopEnd]);
  useEffect(() => {
    audio.engine.current?.setMetronome(metronome, bpm, beatsPerBar, beatUnit);
  }, [audio.engine, audio.loading, metronome, bpm, beatsPerBar, beatUnit]);

  function updateTrack(id: string, patch: Partial<Mix>) {
    const updated = updateMix(mix, id, patch);
    setTracks(tracks.map(t => ({ ...t, ...updated[t.id]! })));
  }
  function seek(value: number) {
    if (song) {
      if (audio.engine.current?.playbackRequested) setPendingPlayback(true);
      void audio.run(e => e.seek(value, mix));
    }
    else setTime(activeLoop && (value < loopStart || value >= loopEnd) ? loopStart : value);
  }
  function togglePlayback() {
    if (song) {
      if (audio.retryRequired) {
        setPendingPlayback(false);
        audio.retryInitialization();
        return;
      }
      const engine = audio.engine.current;
      if (!engine || (engine.playbackRequested && !engine.playing)) return;
      if (engine.playing) engine.pause();
      else {
        setPendingPlayback(true);
        void audio.run(e => e.play(mix));
      }
    } else {
      if (!isPlaying && activeLoop && (time < loopStart || time >= loopEnd)) setTime(loopStart);
      else if (!isPlaying && time >= duration) setTime(0);
      setPlaying(!isPlaying);
    }
  }

  // Neither the cursor nor Solo/Mute changes geometry. Cache each immutable
  // peaks response so loading another track does not rebuild all earlier paths.
  const waveCache = useMemo(() => ({ duration, paths: new WeakMap<Wave, string>() }), [duration]);
  const wavePaths = useMemo(() => Object.fromEntries((song
    ? song.tracks.map(track => ({ id: track.id, waveform: [] as number[] })) : mockTracks).map(track => {
    const wave = audio.waves[track.id];
    if (wave) {
      const cached = waveCache.paths.get(wave);
      if (cached !== undefined) return [track.id, cached];
      const upper = wave.points.map((p, i) => `${i * wave.stepMs / duration},${50 - p[1] * 46}`).join(' ');
      const lower = wave.points.map((p, i) => `${Math.min(wave.durationMs, (i + 1) * wave.stepMs) / duration},${50 - p[0] * 46}`).reverse().join(' ');
      const points = `${upper} ${lower}`;
      waveCache.paths.set(wave, points);
      return [track.id, points];
    }
    if (song) return [track.id, ''];
    const waveform = Array.from({ length: 24 * bars }, (_, i) => track.waveform[i % track.waveform.length] ?? 0);
    const upper = waveform.map((height, i) => `${i / (waveform.length - 1) * 1000},${50 - height * 0.46}`).join(' ');
    const lower = waveform.map((height, i) => `${i / (waveform.length - 1) * 1000},${50 + height * 0.46}`).reverse().join(' ');
    return [track.id, `${upper} ${lower}`];
  })), [audio.waves, duration, bars, song, waveCache]);
  const barNumbers = useMemo(() => Array.from({ length: count }, (_, index) =>
    <span key={index} style={song ? { flex: `0 0 ${realBarDuration / (duration || 1) * 100}%` } : undefined}>{index + 1}</span>
  ), [count, realBarDuration, duration, song]);

  const gridStyle = {
    '--bars': song && duration ? duration / realBarDuration : count,
    '--timeline-width': `${Math.min(count * 76, 100000)}px`,
    '--loop-left': `${loopStart / (duration || 1) * 100}%`,
    '--loop-width': `${(loopEnd - loopStart) / (duration || 1) * 100}%`,
    '--beats': song ? duration / realBarDuration * beatsPerBar : count * beatsPerBar,
  } as CSSProperties;

  return (
    <main className={styles.shell}>
      <section className={styles.player} aria-label="Плеер репетиции">
        <header className={styles.scoreHeader}>
          <p className={styles.eyebrow}>Моя репетиция</p>
          <h1 className={styles.title}>{song?.title ?? pieceTitle}</h1>
          <div className={styles.metadata}>
            <span className={styles.pill}>{bpm} BPM</span>
            <span className={styles.pill}>{beatsPerBar}/{beatUnit}</span>
            <span className={styles.subtitle}>{`${song ? "Песня" : "Учебный фрагмент"} · ${count} ${barLabel}`}</span>
          </div>
        </header>

        <div className={styles.transport} aria-label="Управление воспроизведением">
          <div className={styles.playback}>
            <button className={styles.iconButton} type="button" aria-label="Вернуться к началу" title="Вернуться к началу" onClick={() => seek(0)}>
              <PlayerIcon name="restart" />
            </button>
            <button className={styles.playButton} disabled={playbackLoading} type="button" aria-label={playbackLabel} aria-busy={playbackLoading} title={playbackLabel} onClick={togglePlayback}>
              <PlayerIcon name={isPlaying && !playbackLoading ? 'pause' : 'play'} />
            </button>
            <span className={styles.time} aria-label={`${formatTime(time)} из ${formatTime(duration)}`}>
              {formatTime(time)} <span>/ {formatTime(duration)}</span>
            </span>
          </div>
          <div className={styles.options}>
            <button className={styles.optionButton} type="button" aria-label="Повтор фрагмента" aria-pressed={activeLoop} disabled={!validRange || duration <= 0} title="Повторить выбранные такты" onClick={() => setLoop(!loop)}>
              <PlayerIcon name="loop" /><span>Повтор</span>
            </button>
            <button className={styles.optionButton} type="button" aria-label="Метроном" aria-pressed={metronome} title={song ? "Звуковой метроном" : "Визуальный метроном (демо без звука)"} onClick={() => setMetronome(!metronome)}>
              <PlayerIcon name="metronome" /><span>Метроном</span>
            </button>
          </div>
          <div className={styles.transportStatus}>
            <span role="status">{playbackLoading ? 'Загрузка аудио…' : activeLoop ? `Повтор: такты ${range[0]}–${range[1]}` : `Все партии · ${count} ${barLabel}`}</span>
            {metronome && <span className={styles.beats} aria-label="Визуальный метроном">
              {Array.from({ length: beatsPerBar }, (_, index) => <i key={index} data-active={isPlaying && index === currentBeat} />)}
            </span>}
          </div>
        </div>

        <div className={styles.loopControls} role="group" aria-label="Такты повтора">
          <label htmlFor={`${rangeId}-start`}>С такта
            <input id={`${rangeId}-start`} name="loopStart" type="number" inputMode="numeric" min={1} max={count} step={1}
              value={Number.isNaN(range[0]) ? '' : range[0]} aria-invalid={!validRange} aria-describedby={!validRange ? `${rangeId}-error` : undefined}
              onChange={event => setRange([event.currentTarget.valueAsNumber, range[1]])} />
          </label>
          <label htmlFor={`${rangeId}-end`}>По такт
            <input id={`${rangeId}-end`} name="loopEnd" type="number" inputMode="numeric" min={1} max={count} step={1}
              value={Number.isNaN(range[1]) ? '' : range[1]} aria-invalid={!validRange} aria-describedby={!validRange ? `${rangeId}-error` : undefined}
              onChange={event => setRange([range[0], event.currentTarget.valueAsNumber])} />
          </label>
          {!validRange && <span id={`${rangeId}-error`} role="alert">Укажите целые такты: 1 ≤ начало ≤ конец ≤ {count}.</span>}
        </div>
        <section className={styles.timeline} style={gridStyle} aria-label="Общий таймлайн партий">
          <div className={styles.timelineViewport} ref={timelineRef} tabIndex={0} role="region" aria-label="Прокрутка тактов">
          <div className={styles.timelineContent}>
          <div className={styles.barNumbers} style={song ? { display: "flex", overflow: "hidden" } : undefined} aria-hidden="true">
            {barNumbers}
          </div>
          <div className={styles.waveStack}>
            <svg className={styles.waves} viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">
              {tracks.map((track) => {
                const quiet = track.muted || track.volume === 0 || (hasSolo && !track.solo);
                return <polygon key={track.id} points={wavePaths[track.id]} data-quiet={quiet} data-track={track.name.toLowerCase() === "минус" ? "backing" : track.id}
                  style={{ '--wave-color': `var(--color-${track.tone})` } as CSSProperties}
                  vectorEffect="non-scaling-stroke" />;
              })}
            </svg>
            {activeLoop && <div className={styles.loopRegion} aria-hidden="true" />}
            <div className={styles.cursor} style={{ '--position': `${time / (duration || 1) * 100}%` } as CSSProperties} aria-hidden="true"><span /></div>
          </div>
          </div>
          </div>
          <label className="visually-hidden" htmlFor={positionId}>Позиция воспроизведения</label>
          <input className={styles.seek} id={positionId} type="range" min="0" max={duration} step="0.01" value={time}
            aria-valuetext={`${formatTime(time)} из ${formatTime(duration)}`}
            onChange={(event) => seek(Number(event.currentTarget.value))} />
        </section>

        {loopError && <p role="alert">{loopError}</p>}
        {audio.error && <p role="alert">{audio.error}</p>}
        {import.meta.env.DEV && Object.keys(audio.diagnostics).length > 0 && <details className={styles.diagnostics}>
          <summary>Диагностика воспроизведения</summary>
          <pre>{JSON.stringify(Object.values(audio.diagnostics), null, 2)}</pre>
        </details>}
        <section className={styles.mixerSection} aria-label="Микшер партий">
          <div className={styles.mixer}>
            {tracks.map((track) => (
              <div className={styles.channel} key={track.id} role="group" aria-label={`Партия: ${track.name}`}>
                <TrackControls
                  loading={!!song && audio.states[track.id] === "Загрузка…"}
                  disabled={!!song && !audio.states[track.id]?.startsWith("Готово")}
                  name={track.name} volume={track.volume} muted={track.muted} solo={track.solo} tone={track.tone}
                  orientation="vertical"
                  onVolumeChange={(volume) => updateTrack(track.id, { volume })}
                  onMuteChange={(muted) => updateTrack(track.id, { muted })}
                  onSoloChange={(solo) => updateTrack(track.id, { solo })}
                />
                {song && <small role="status">{audio.states[track.id] ?? "Ожидание…"}</small>}
              </div>
            ))}
          </div>
        </section>

      </section>
      {song?.notes && <p>{song.notes}</p>}
      <p className={styles.hint}><strong>S</strong> — слушать выбранные партии <span>·</span> <strong>M</strong> — выключить партию</p>
    </main>
  );
}
