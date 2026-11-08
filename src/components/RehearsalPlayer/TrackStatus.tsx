import { useId } from 'react';
import { Button } from '../ui/Button';
import styles from './TrackStatus.module.css';

/** The audio hook owns readiness; this control only explains its current status. */
export function TrackStatus({ name, state }: { name: string; state?: string | undefined }) {
  const id = useId();
  const ready = state === 'Готово';
  const waiting = !state || state === 'Ожидание…' || state === 'Загрузка…';
  const warning = !!state?.startsWith('Готово ·');
  const tone = ready ? 'ready' : waiting || warning ? 'pending' : 'error';
  const text = ready ? 'Готово к воспроизведению' : warning ? 'Аудио готово, волна недоступна' : state || 'Ожидание…';
  return <div className={styles.status}>
    <span className="visually-hidden" role="status">{name}: {text}</span>
    <Button variant="text" size="icon" popoverTarget={id} aria-label={`Состояние: ${name}. ${text}`}>
      <span className={styles.indicator} data-tone={tone} aria-hidden="true">{ready ? '✓' : waiting ? '…' : '!'}</span>
    </Button>
    <div id={id} popover="auto" role="dialog" aria-label={`Состояние партии: ${name}`} className={styles.description}>
      <strong>{name}</strong>
      <p>{text}</p>
      <Button variant="text" popoverTarget={id} popoverTargetAction="hide">Закрыть</Button>
    </div>
  </div>;
}
