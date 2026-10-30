import type { ComponentPropsWithRef } from 'react';
import { buttonClassName } from './Button';
import type { ButtonAppearance } from './Button';

export type ActionLinkProps = ComponentPropsWithRef<'a'> & ButtonAppearance & { href: string };

/** Button appearance with native link navigation, targets and modifier keys. */
export function ActionLink({ variant, size, className, ...props }: ActionLinkProps) {
  return <a {...props} className={buttonClassName({ variant, size, className })} />;
}
