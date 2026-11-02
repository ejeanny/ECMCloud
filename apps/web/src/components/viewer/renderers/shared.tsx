'use client';

import type { ReactNode } from 'react';
import { CircleAlert, Loader2 } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

/** Every renderer is handed the same thing: a document and where its bytes are. */
export interface RendererProps {
  nodeId: string;
  name: string;
  ext: string | null;
  byteLength: number | null;
  /** Lets a renderer tell the shell how many pages it has, and which is current. */
  onPages?: (pages: { count: number; current: number; labels?: string[] }) => void;
  /** The shell asks for a page; renderers that have none ignore it. */
  goToPage?: number;
}

/** The URL the bytes come from. The API streams it and sets the content type. */
export function fileUrl(nodeId: string): string {
  return `/file/${nodeId}`;
}

export function RendererLoading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center gap-2 p-8 text-sm">
      <Loader2 className="size-4 animate-spin" />
      {label}…
    </div>
  );
}

export function RendererError({ title, message }: { title: string; message: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <Alert variant="destructive" className="max-w-md">
        <CircleAlert />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    </div>
  );
}

/** The grey the PDF viewer puts behind a page, reused so formats look alike. */
export const STAGE =
  'flex h-full min-h-0 w-full justify-center overflow-auto bg-neutral-600 p-4 scrollbar-thin';

/** A white sheet, the way a page reads. */
export const SHEET = 'bg-white text-neutral-900 shadow-[0_2px_10px_rgb(0_0_0/0.35)]';
