import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const variants = cva('button', { variants: { variant: { default: 'button-primary', outline: 'button-outline', danger: 'button-danger', ghost: 'button-ghost' }, size: { default: '', sm: 'button-sm' } }, defaultVariants: { variant: 'default', size: 'default' } });
export function Button({ className, variant, size, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof variants>) {
  return <button className={cn(variants({ variant, size }), className)} {...props} />;
}
