'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Download, ExternalLink, Lock, LockOpen, Undo2, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CheckInDialog } from './check-in-dialog';
import { trpc } from '@/lib/trpc';

export interface GridNode {
  id: string;
  cabinetId: string;
  kind: string;
  name: string;
  ext: string | null;
  isCheckedOut: boolean;
  checkedOutBy: string | null;
  checkedOutById: string | null;
}

interface Props {
  node: GridNode;
  /** The signed-in user, to tell "I hold this" from "someone else does". */
  me: string | null;
  readOnly: boolean;
  onChanged: () => void;
}

/** Where a document opens: the viewer reads PDF, everything else is its bytes. */
export function openHrefFor(node: { id: string; ext: string | null }): string {
  return node.ext?.toLowerCase() === 'pdf' ? `/v/${node.id}` : `/file/${node.id}`;
}

/**
 * The actions that used to need a selection and a trip to the side panel.
 *
 * Checking a document out and back in is the loop this application exists for,
 * and it cost four clicks and a panel: select the row, read the panel, press
 * Check out, and later press Check in — which could not even take the revised
 * file. Here it is one press on the row, and the row says who holds the lock.
 *
 * The buttons stay hidden until the row is hovered, selected, under the
 * keyboard cursor, or holds focus — a grid of buttons is harder to read than a
 * grid of names. They are icons with tooltips rather than labelled buttons so
 * the column stays narrow enough to leave the file name room to be read.
 */
export function RowActions({ node, me, readOnly, onChanged }: Props) {
  const router = useRouter();
  const [checkingIn, setCheckingIn] = useState(false);
  const checkOut = trpc.version.checkOut.useMutation({ onSuccess: onChanged });
  const cancel = trpc.version.cancelCheckOut.useMutation({ onSuccess: onChanged });

  if (node.kind === 'folder') return null;

  const mine = node.isCheckedOut && node.checkedOutById !== null && node.checkedOutById === me;
  const theirs = node.isCheckedOut && !mine;
  const isPdf = node.ext?.toLowerCase() === 'pdf';

  // Clicks inside the row must not also select it; each one is its own action.
  const act = (fn: () => void) => (event: React.MouseEvent) => {
    event.stopPropagation();
    fn();
  };

  return (
    <span
      className="invisible inline-flex items-center gap-1 group-hover/row:visible group-aria-selected/row:visible group-data-[cursor=true]/row:visible focus-within:visible"
      onClick={(e) => e.stopPropagation()}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Open"
            onClick={act(() => {
              if (isPdf) router.push(`/v/${node.id}`);
              else window.open(`/file/${node.id}`, '_blank', 'noopener');
            })}
          >
            <ExternalLink />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{isPdf ? 'Open in the viewer' : 'Open the file'}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-xs" asChild>
            <a
              href={`/file/${node.id}/download`}
              aria-label="Download"
              onClick={(e) => e.stopPropagation()}
            >
              <Download />
            </a>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Download</TooltipContent>
      </Tooltip>

      {theirs ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-muted-foreground inline-flex size-7 items-center justify-center">
              <Lock className="size-3.5" />
              <span className="sr-only">Checked out by {node.checkedOutBy}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>Checked out by {node.checkedOutBy}</TooltipContent>
        </Tooltip>
      ) : mine ? (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-xs"
                aria-label="Check in"
                onClick={act(() => setCheckingIn(true))}
              >
                <Upload />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Check in, with or without a revised file</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Cancel check-out"
                disabled={cancel.isPending}
                onClick={act(() => cancel.mutate({ nodeId: node.id }))}
              >
                <Undo2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Give up the lock and keep the document as it is</TooltipContent>
          </Tooltip>
        </>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Check out"
              disabled={readOnly || checkOut.isPending}
              onClick={act(() => checkOut.mutate({ nodeId: node.id }))}
            >
              <LockOpen />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Take the lock so nobody else edits it</TooltipContent>
        </Tooltip>
      )}

      {checkingIn ? (
        <CheckInDialog
          nodeId={node.id}
          cabinetId={node.cabinetId}
          name={node.name}
          onClose={() => setCheckingIn(false)}
          onDone={onChanged}
        />
      ) : null}
    </span>
  );
}
