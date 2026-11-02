'use client';

import { useState } from 'react';
import {
  Download,
  Maximize,
  RotateCw,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatFor, type ViewerFormat } from '@/lib/viewer/formats';
import { convertsToPdf } from '@/lib/viewer/to-pdf';
import { PdfViewer } from './pdf-viewer';
import { CsvRenderer } from './renderers/csv-renderer';
import { DocxRenderer } from './renderers/docx-renderer';
import { HtmlRenderer } from './renderers/html-renderer';
import { ImageRenderer } from './renderers/image-renderer';
import { MarkdownRenderer } from './renderers/markdown-renderer';
import { MediaRenderer } from './renderers/media-renderer';
import { TextRenderer } from './renderers/text-renderer';
import { UnsupportedRenderer } from './renderers/unsupported-renderer';

interface Props {
  nodeId: string;
  name: string;
  ext: string | null;
  byteLength: number | null;
  onClose: () => void;
}

/** Formats where making it bigger or smaller means anything. */
const ZOOMABLE = new Set<ViewerFormat>(['image', 'text', 'markdown', 'csv', 'docx']);
/** Only a picture turns. */
const ROTATABLE = new Set<ViewerFormat>(['image']);

const FORMAT_LABEL: Partial<Record<ViewerFormat, string>> = {
  markdown: 'Markdown',
  csv: 'Table',
  docx: 'Word',
  html: 'Web page',
};

/**
 * The viewer.
 *
 * Every document opens here, whatever it is. The format decides which renderer
 * draws the body; PDF keeps a window of its own because it carries machinery
 * none of the others have — annotations, a text layer, in-document search —
 * and folding that into a shared toolbar would only make both harder to read.
 */
export function DocumentViewer({ nodeId, name, ext, byteLength, onClose }: Props) {
  const format = formatFor(ext);

  // A raster image opens as a PDF of one page, which is how Apryse shows one
  // (PDF-VIEWER.md §2, `loadAsPDF`). It is not presentation for its own sake:
  // annotations, the text layer, search and thumbnails are all built on PDF
  // pages, so an image shown as an `<img>` is an image nobody can mark up.
  if (format === 'pdf' || convertsToPdf(ext)) {
    return <PdfViewer nodeId={nodeId} name={name} ext={ext} onClose={onClose} />;
  }

  return (
    <SimpleViewer
      nodeId={nodeId}
      name={name}
      ext={ext}
      byteLength={byteLength}
      format={format}
      onClose={onClose}
    />
  );
}

function SimpleViewer({
  nodeId,
  name,
  ext,
  byteLength,
  format,
  onClose,
}: Props & { format: ViewerFormat }) {
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);

  const zoomable = ZOOMABLE.has(format);
  const rotatable = ROTATABLE.has(format);
  const label = FORMAT_LABEL[format] ?? ext?.toUpperCase() ?? 'File';

  const body = (() => {
    const common = { nodeId, name, ext, byteLength };
    switch (format) {
      case 'image':
        return <ImageRenderer {...common} scale={scale} rotation={rotation} />;
      case 'markdown':
        return <MarkdownRenderer {...common} scale={scale} />;
      case 'csv':
        return <CsvRenderer {...common} scale={scale} />;
      case 'docx':
        return <DocxRenderer {...common} scale={scale} />;
      case 'html':
        return <HtmlRenderer {...common} />;
      case 'audio':
        return <MediaRenderer {...common} kind="audio" />;
      case 'video':
        return <MediaRenderer {...common} kind="video" />;
      case 'text':
        return <TextRenderer {...common} scale={scale} />;
      default:
        return <UnsupportedRenderer {...common} />;
    }
  })();

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="bg-card flex flex-wrap items-center gap-2 rounded-xl border p-2">
        <strong className="max-w-[28ch] truncate text-sm" title={name}>
          {name}
        </strong>
        <Badge variant="secondary">{label}</Badge>

        {zoomable || rotatable ? <Separator orientation="vertical" className="h-5" /> : null}

        {zoomable ? (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Zoom out"
              onClick={() => setScale((s) => Math.max(0.25, Number((s - 0.15).toFixed(2))))}
            >
              <ZoomOut />
            </Button>
            <span className="text-muted-foreground min-w-12 text-center font-mono text-xs tabular-nums">
              {Math.round(scale * 100)}%
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Zoom in"
              onClick={() => setScale((s) => Math.min(5, Number((s + 0.15).toFixed(2))))}
            >
              <ZoomIn />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setScale(1)}>
              <Maximize />
              Reset
            </Button>
          </div>
        ) : null}

        {rotatable ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Rotate"
                onClick={() => setRotation((r) => (r + 90) % 360)}
              >
                <RotateCw />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Rotate a quarter turn</TooltipContent>
          </Tooltip>
        ) : null}

        <span className="flex-1" />

        <Button asChild variant="outline" size="sm">
          <a href={`/file/${nodeId}/download`}>
            <Download />
            Download
          </a>
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Close viewer" onClick={onClose}>
          <X />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border">{body}</div>
    </div>
  );
}
