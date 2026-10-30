import type { ComponentPropsWithRef } from 'react';
import styles from './Field.module.css';

export type SelectProps = ComponentPropsWithRef<'select'> & { textSize?: 'normal' | 'small' };

export function Select({ className, textSize = 'normal', ...props }: SelectProps) {
  return <select {...props} className={[styles.field, styles.select, textSize === 'small' && styles.smallText, className].filter(Boolean).join(' ')} />;
}
