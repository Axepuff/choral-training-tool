import { Message } from '../ui/Message';
import { RangeSlider } from '../ui/RangeSlider';
import { Button } from '../ui/Button';
import { useId } from 'react';
import styles from './TrackControls.module.css';

export type TrackTone = 'soprano' | 'alto' | 'tenor' | 'bass' | 'backing';

export interface TrackControlsProps {
  /** Название партии, используемое также в доступных именах элементов. */
  name: string;
  /** Громкость от 0 до 100. */
  volume: number;
  /** Выключает партию, сохраняя её громкость. */
  muted: boolean;
  /** Выделяет партию для репетиции. Несколько партий могут быть Solo. */
  solo: boolean;
  /** Блокирует управление и показывает состояние загрузки. */
  loading?: boolean;
  disabled?: boolean;
  /** Идентификатор партии; фейдеры используют единый основной цвет. */
  tone?: TrackTone;
  /** Вертикальный фейдер для компактного микшера или горизонтальный ползунок. */
  orientation?: 'horizontal' | 'vertical';
  onVolumeChange: (volume: number) => void;
  onMuteChange: (muted: boolean) => void;
  onSoloChange: (solo: boolean) => void;
}

/** Управление одной партией. Состояние принадлежит приложению или story. */
export function TrackControls({
  name, volume, muted, solo, loading = false, disabled = false, tone = 'soprano', orientation = 'horizontal',
  onVolumeChange, onMuteChange, onSoloChange,
}: TrackControlsProps) {
  const volumeId = useId();
  const safeVolume = Math.min(100, Math.max(0, volume));

  return (
    <div className={styles.controls} data-tone={tone} data-orientation={orientation} aria-busy={loading}>
      <div className={styles.heading}>
        <span className={styles.name}>{name}</span>
        {loading && <Message as="span" tone="muted" variant="spinner" className={styles.loading} role="status" aria-label={`Загрузка: ${name}`} />}
      </div>
      <div className={styles.actions}>
        <Button
          type="button" variant="solo" size="icon" className={styles.solo}
          aria-label={`Solo: ${name}`} aria-pressed={solo}
          title={`Solo — слушать только выбранные партии (${name})`}
          disabled={loading || disabled} onClick={() => { if (!solo && muted) onMuteChange(false); onSoloChange(!solo); }}
        >S</Button>
        <Button
          type="button" variant="mute" size="icon" className={styles.mute}
          aria-label={`Mute: ${name}`} aria-pressed={muted}
          title={`Mute — выключить партию (${name})`}
          disabled={loading || disabled} onClick={() => { if (!muted && solo) onSoloChange(false); onMuteChange(!muted); }}
        >M</Button>
        <label className="visually-hidden" htmlFor={volumeId}>Громкость: {name}</label>
        <RangeSlider
          id={volumeId} className={styles.volume} min="0" max="100" step="1"
          value={safeVolume} aria-valuetext={`${safeVolume}%`} aria-orientation={orientation} disabled={loading || disabled}
          orientation={orientation} muted={muted} onChange={(event) => onVolumeChange(Number(event.currentTarget.value))}
        />
        <output className={styles.value} htmlFor={volumeId}>{safeVolume}<span className="visually-hidden">%</span></output>
      </div>
    </div>
  );
}
