'use client';

import { useState } from 'react';
import { Loader2, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { InlineError } from '@/components/states';
import { useChunkedUpload } from '@/lib/upload';
import { trpc } from '@/lib/trpc';

interface Props {
  nodeId: string;
  cabinetId: string;
  name: string;
  onClose: () => void;
  onDone: () => void;
}

const BUMPS = [
  { value: 'minor', label: 'Minor — a correction or small change' },
  { value: 'major', label: 'Major — a new round of the document' },
  { value: 'overwrite', label: 'Overwrite — keep no version of what is there' },
] as const;

/**
 * Check a document back in, with the revised file.
 *
 * `version.checkIn` has always accepted an `uploadId` — the UI never sent one,
 * so checking out was a one-way door: you could take the lock and had no way
 * to put a changed file back through the app. Staging the bytes and passing
 * the id is the whole fix; the rest is giving the version a number and a
 * reason someone can read later.
 *
 * Radix's Dialog supplies the focus trap, the Escape handler and the
 * `aria-modal` wiring this used to do by hand.
 */
export function CheckInDialog({ nodeId, cabinetId, name, onClose, onDone }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [bump, setBump] = useState<'minor' | 'major' | 'overwrite'>('minor');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { stage, progress } = useChunkedUpload();
  const checkIn = trpc.version.checkIn.useMutation();

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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Check in</DialogTitle>
          <DialogDescription className="break-words">{name}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="checkin-file">Revised file</Label>
            <Input
              id="checkin-file"
              type="file"
              disabled={busy}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <p className="text-muted-foreground text-xs">
              {file
                ? `${file.name} replaces the current content; what is stored now becomes a version.`
                : 'Leave empty to release the lock without changing the document.'}
            </p>
          </div>

          {file ? (
            <div className="space-y-2">
              <Label htmlFor="checkin-bump">Version</Label>
              <Select
                value={bump}
                disabled={busy}
                onValueChange={(value) => setBump(value as typeof bump)}
              >
                <SelectTrigger id="checkin-bump">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BUMPS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {bump === 'overwrite' ? (
                <Alert variant="destructive">
                  <TriangleAlert />
                  <AlertDescription>
                    The current content will not be recoverable.
                  </AlertDescription>
                </Alert>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="checkin-comment">What changed</Label>
            <Textarea
              id="checkin-comment"
              rows={2}
              value={comment}
              disabled={busy}
              placeholder="Shown against the version in the history"
              onChange={(e) => setComment(e.target.value)}
            />
          </div>

          {error ? <InlineError message={error} /> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {progress
              ? `Uploading ${progress.done}/${progress.total}`
              : busy
                ? 'Checking in…'
                : file
                  ? 'Check in with this file'
                  : 'Release the lock'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
