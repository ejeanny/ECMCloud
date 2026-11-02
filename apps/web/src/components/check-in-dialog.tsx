'use client';

import { useEffect, useRef, useState } from 'react';
import { useChunkedUpload } from '@/lib/upload';
import { trpc } from '@/lib/trpc';

interface Props {
  nodeId: string;
  cabinetId: string;
  name: string;
  onClose: () => void;
  onDone: () => void;
}

/**
 * Check a document back in, with the revised file.
 *
 * `version.checkIn` has always accepted an `uploadId` — the UI never sent one,
 * so checking out was a one-way door: you could take the lock and had no way
 * to put a changed file back through the app. Staging the bytes and passing
 * the id is the whole fix; the rest is giving the version a number and a
 * reason someone can read later.
 */
export function CheckInDialog({ nodeId, cabinetId, name, onClose, onDone }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [bump, setBump] = useState<'minor' | 'major' | 'overwrite'>('minor');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);

  const { stage, progress } = useChunkedUpload();
  const checkIn = trpc.version.checkIn.useMutation();

  // Escape closes, and focus starts inside, so the dialog is usable without
  // reaching for the mouse at all.
  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>('input,select,button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      // No file means "release the lock, keep what is stored" — which is what
      // the old button did, kept because it is a real thing to want.
      const uploadId = file ? await stage(file, { cabinetId, parentId: null }) : undefined;
      await checkIn.mutateAsync({
        nodeId,
        bump,
        comment: comment.trim() || undefined,
        uploadId,
      });
      onDone();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div
        className="card modal"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={`Check in ${name}`}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>Check in</h3>
        <p className="small muted" style={{ marginTop: 0, wordBreak: 'break-word' }}>
          {name}
        </p>

        <div className="field">
          <label htmlFor="checkin-file">Revised file</label>
          <input
            id="checkin-file"
            type="file"
            disabled={busy}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <p className="small muted" style={{ margin: '4px 0 0' }}>
            {file
              ? `${file.name} replaces the current content; what is stored now becomes a version.`
              : 'Leave empty to release the lock without changing the document.'}
          </p>
        </div>

        {file ? (
          <div className="field">
            <label htmlFor="checkin-bump">Version</label>
            <select
              id="checkin-bump"
              value={bump}
              disabled={busy}
              onChange={(e) => setBump(e.target.value as typeof bump)}
            >
              <option value="minor">Minor — a correction or small change</option>
              <option value="major">Major — a new round of the document</option>
              <option value="overwrite">
                Overwrite — keep no version of what is there
              </option>
            </select>
            {bump === 'overwrite' ? (
              <p className="small error" style={{ margin: '4px 0 0' }}>
                The current content will not be recoverable.
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="field">
          <label htmlFor="checkin-comment">What changed</label>
          <textarea
            id="checkin-comment"
            rows={2}
            value={comment}
            disabled={busy}
            placeholder="Shown against the version in the history"
            onChange={(e) => setComment(e.target.value)}
          />
        </div>

        {error ? (
          <p className="error small" role="alert">
            {error}
          </p>
        ) : null}

        <div className="row">
          <button className="primary" onClick={submit} disabled={busy}>
            {progress
              ? `Uploading ${progress.done}/${progress.total}`
              : busy
                ? 'Checking in…'
                : file
                  ? 'Check in with this file'
                  : 'Release the lock'}
          </button>
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
