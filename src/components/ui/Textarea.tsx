import type { ComponentPropsWithRef } from 'react';
import styles from './Field.module.css';

export type TextareaProps = ComponentPropsWithRef<'textarea'>;

export function Textarea({ className, ...props }: TextareaProps) {
  return <textarea {...props} className={[styles.field, styles.textarea, className].filter(Boolean).join(' ')} />;
}
