'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
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
    <span className="row-actions" onClick={(e) => e.stopPropagation()}>
      <button
        className="small"
        title={isPdf ? 'Open in the viewer' : 'Open the file'}
        onClick={act(() => {
          if (isPdf) router.push(`/v/${node.id}`);
          else window.open(`/file/${node.id}`, '_blank', 'noopener');
        })}
      >
        Open
      </button>

      <a
        className="small pill"
        href={`/file/${node.id}/download`}
        title="Download"
        onClick={(e) => e.stopPropagation()}
      >
        Save
      </a>

      {theirs ? (
        <span className="small muted" title={`Checked out by ${node.checkedOutBy}`}>
          with {node.checkedOutBy}
        </span>
      ) : mine ? (
        <>
          <button
            className="small primary"
            title="Check in, with or without a revised file"
            onClick={act(() => setCheckingIn(true))}
          >
            Check in
          </button>
          <button
            className="small"
            title="Give up the lock and keep the document as it is"
            onClick={act(() => cancel.mutate({ nodeId: node.id }))}
          >
            Cancel
          </button>
        </>
      ) : (
        <button
          className="small"
          disabled={readOnly || checkOut.isPending}
          title="Take the lock so nobody else edits it"
          onClick={act(() => checkOut.mutate({ nodeId: node.id }))}
        >
          Check out
        </button>
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
