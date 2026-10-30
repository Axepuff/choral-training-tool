import type { ComponentPropsWithoutRef } from 'react';
import styles from './Message.module.css';

export type MessageProps = ComponentPropsWithoutRef<'div'> & {
  as?: 'p' | 'span' | 'div' | 'section' | 'small';
  tone?: 'muted' | 'info' | 'error';
  variant?: 'plain' | 'banner' | 'confirmation' | 'spinner';
  size?: 'normal' | 'small' | 'compact' | 'micro';
};

/** Presentation only: callers retain role, live-region policy and field associations. */
export function Message({ as: Element = 'p', tone = 'muted', variant = 'plain', size = 'normal', className, ...props }: MessageProps) {
  return <Element {...props} className={[styles.message, styles[tone], styles[variant], styles[size], className].filter(Boolean).join(' ')} />;
}
