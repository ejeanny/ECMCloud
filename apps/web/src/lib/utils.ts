import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** The shadcn/ui class helper: conditional classes, with later Tailwind
 *  utilities beating earlier ones rather than fighting them in the cascade. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
