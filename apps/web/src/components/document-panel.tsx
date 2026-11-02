'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  Download,
  Eye,
  History,
  Loader2,
  Lock,
  LockOpen,
  MessageSquare,
  RotateCcw,
  Trash2,
  Undo2,
  Upload,
  Workflow,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { EmptyState, ErrorState, InlineError } from '@/components/states';
import { formatBytes, formatDate, formatIndexValue } from '@/lib/format';
import { viewerHrefFor } from '@/lib/viewer/formats';
import { CheckInDialog } from './check-in-dialog';
import { trpc } from '@/lib/trpc';

interface Props {
  nodeId: string;
  onChanged: () => void;
}

/** The right-hand detail panel: index values, versions, notes, workflow. */
export function DocumentPanel({ nodeId, onChanged }: Props) {
  const detail = trpc.node.byId.useQuery({ nodeId });
  const utils = trpc.useUtils();
  const touch = trpc.workspace.touchRecent.useMutation();

  useEffect(() => {
    if (detail.data?.node.kind === 'document') touch.mutate({ nodeId });
    // Recording a view is a side effect of opening it, not of re-rendering.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, detail.data?.node.kind]);

  if (detail.isLoading) {
    return (
      <aside className="bg-card space-y-3 rounded-xl border p-5">
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-40 w-full" />
      </aside>
    );
  }

  if (detail.error) {
    return (
      <aside>
        <ErrorState message={detail.error.message} />
      </aside>
    );
  }

  if (!detail.data) return null;

  const { node, index, checkedOutBy, versionCount, noteCount } = detail.data;

  function refresh() {
    void utils.node.byId.invalidate({ nodeId });
    onChanged();
  }

  return (
    <aside className="bg-card sticky top-5 overflow-hidden rounded-xl border">
      <div className="space-y-2 p-4">
        <h2 className="text-sm leading-snug font-semibold break-words">{node.name}</h2>

        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary">
            {node.kind === 'folder' ? 'Folder' : (node.ext?.toUpperCase() ?? 'FILE')}
          </Badge>
          {node.kind === 'document' ? (
            <Badge variant="outline" className="tabular-nums">
              {formatBytes(node.byteLength)}
            </Badge>
          ) : null}
          {node.pages ? (
            <Badge variant="outline" className="tabular-nums">
              {node.pages} pages
            </Badge>
          ) : null}
          {checkedOutBy ? (
            <Badge variant="warning">
              <Lock />
              {checkedOutBy}
            </Badge>
          ) : null}
        </div>

        {node.kind === 'document' ? (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {/* Every format opens in the viewer; only PDF can be annotated,
                because the annotations are XFDF stored against the page. */}
            <Button asChild size="xs">
              <Link href={viewerHrefFor(node)}>
                <Eye />
                {node.ext?.toLowerCase() === 'pdf' ? 'View & annotate' : 'View'}
              </Link>
            </Button>
            <Button asChild size="xs" variant="outline">
              <a href={`/file/${node.id}/download`}>
                <Download />
                Download
              </a>
            </Button>
            <CheckOutControls
              nodeId={node.id}
              cabinetId={node.cabinetId}
              name={node.name}
              isCheckedOut={node.isCheckedOut}
              onChanged={refresh}
            />
          </div>
        ) : null}
      </div>

      <Separator />

      <Tabs defaultValue="index" className="gap-0">
        <div className="px-4 pt-3">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="index">Index</TabsTrigger>
            <TabsTrigger value="versions">
              <History />
              {versionCount}
            </TabsTrigger>
            <TabsTrigger value="notes">
              <MessageSquare />
              {noteCount}
            </TabsTrigger>
            <TabsTrigger value="workflow">
              <Workflow />
            </TabsTrigger>
          </TabsList>
        </div>

        <ScrollArea className="max-h-[min(28rem,calc(100dvh-24rem))]">
          <div className="p-4">
            <TabsContent value="index">
              <IndexForm nodeId={node.id} fields={index} onSaved={refresh} />
            </TabsContent>
            <TabsContent value="versions">
              <Versions nodeId={node.id} onChanged={refresh} />
            </TabsContent>
            <TabsContent value="notes">
              <Notes nodeId={node.id} onChanged={refresh} />
            </TabsContent>
            <TabsContent value="workflow">
              <WorkflowHistory nodeId={node.id} />
            </TabsContent>
          </div>
        </ScrollArea>
      </Tabs>

      <Separator />

      <p className="text-muted-foreground p-4 text-xs">
        Created {formatDate(node.created)} · modified {formatDate(node.modified)}
        {node.textExtractedAt
          ? ` · text extracted ${formatDate(node.textExtractedAt)}`
          : ''}
      </p>
    </aside>
  );
}

function CheckOutControls({
  nodeId,
  cabinetId,
  name,
  isCheckedOut,
  onChanged,
}: {
  nodeId: string;
  cabinetId: string;
  name: string;
  isCheckedOut: boolean;
  onChanged: () => void;
}) {
  const [checkingIn, setCheckingIn] = useState(false);
  const checkOut = trpc.version.checkOut.useMutation({ onSuccess: onChanged });
  const cancel = trpc.version.cancelCheckOut.useMutation({ onSuccess: onChanged });

  if (!isCheckedOut) {
    return (
      <Button
        size="xs"
        variant="outline"
        disabled={checkOut.isPending}
        onClick={() => checkOut.mutate({ nodeId })}
      >
        {checkOut.isPending ? <Loader2 className="animate-spin" /> : <LockOpen />}
        Check out
      </Button>
    );
  }

  return (
    <>
      {/* The dialog, not a bare mutation: check-in takes the revised file. */}
      <Button size="xs" onClick={() => setCheckingIn(true)}>
        <Upload />
        Check in
      </Button>
      <Button
        size="xs"
        variant="ghost"
        className="text-destructive hover:text-destructive"
        disabled={cancel.isPending}
        onClick={() => cancel.mutate({ nodeId })}
      >
        <Undo2 />
        Cancel check-out
      </Button>
      {checkingIn ? (
        <CheckInDialog
          nodeId={nodeId}
          cabinetId={cabinetId}
          name={name}
          onClose={() => setCheckingIn(false)}
          onDone={onChanged}
        />
      ) : null}
    </>
  );
}

function IndexForm({
  nodeId,
  fields,
  onSaved,
}: {
  nodeId: string;
  fields: Array<{
    fieldId: string;
    label: string;
    type: string;
    isRequired: boolean;
    isLocked: boolean;
    value: unknown;
  }>;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const save = trpc.node.setIndexValues.useMutation({
    onSuccess() {
      setDraft({});
      onSaved();
    },
  });

  const dirty = Object.keys(draft).length > 0;

  if (fields.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">This cabinet has no index fields.</p>
    );
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate({
          nodeId,
          values: Object.entries(draft).map(([fieldId, value]) => ({
            fieldId,
            value: value === '' ? null : value,
          })),
        });
      }}
    >
      {fields.map((f) => {
        const currentValue = draft[f.fieldId] ?? forInput(f.type, f.value);
        return (
          <div className="space-y-1.5" key={f.fieldId}>
            <Label htmlFor={`f-${f.fieldId}`} className="text-muted-foreground text-xs">
              {f.label}
              {f.isRequired ? <span className="text-destructive">*</span> : null}
              {f.isLocked ? (
                <Badge variant="outline" className="ml-1">
                  <Lock />
                  locked
                </Badge>
              ) : null}
            </Label>
            {f.isLocked ? (
              <p className="font-mono text-xs break-words">{formatIndexValue(f.value)}</p>
            ) : (
              <Input
                id={`f-${f.fieldId}`}
                type={inputTypeFor(f.type)}
                value={currentValue}
                required={f.isRequired}
                onChange={(e) => setDraft((d) => ({ ...d, [f.fieldId]: e.target.value }))}
              />
            )}
          </div>
        );
      })}

      {save.error ? <InlineError message={save.error.message} /> : null}

      <div className="flex items-center gap-2 pt-1">
        <Button type="submit" size="sm" disabled={!dirty || save.isPending}>
          {save.isPending ? <Loader2 className="animate-spin" /> : null}
          {save.isPending ? 'Saving…' : 'Save index'}
        </Button>
        {dirty ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => setDraft({})}>
            Discard
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/**
 * A date field comes back as a full ISO timestamp, which `<input type="date">`
 * refuses to display — it needs exactly `yyyy-MM-dd`, and
 * `datetime-local` exactly `yyyy-MM-ddTHH:mm`. Without this the control renders
 * empty and saving the form would clear the stored date.
 */
function forInput(type: string, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (type === 'date' || type === 'datetime') {
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) return '';
    const iso = date.toISOString();
    return type === 'date' ? iso.slice(0, 10) : iso.slice(0, 16);
  }
  return String(value);
}

function inputTypeFor(type: string): string {
  switch (type) {
    case 'number':
    case 'decimal':
    case 'autoNumber':
      return 'number';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime-local';
    default:
      return 'text';
  }
}

function Versions({ nodeId, onChanged }: { nodeId: string; onChanged: () => void }) {
  const versions = trpc.version.list.useQuery({ nodeId });
  const revert = trpc.version.revert.useMutation({ onSuccess: onChanged });

  if (versions.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (versions.error) return <InlineError message={versions.error.message} />;
  if ((versions.data ?? []).length === 0) {
    return (
      <EmptyState
        className="border-0 px-0 py-4"
        icon={<History />}
        title="No earlier versions"
        description="Checking a revised file in creates one."
      />
    );
  }

  return (
    <ul className="divide-y">
      {versions.data!.map((v) => (
        <li key={v.id} className="space-y-1 py-2.5 first:pt-0">
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="font-mono">
              {v.label}
            </Badge>
            <span className="flex-1" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-xs" asChild>
                  <a
                    href={`/file/${nodeId}/download?version=${v.id}`}
                    aria-label={`Download version ${v.label}`}
                  >
                    <Download />
                  </a>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Download version {v.label}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Revert to version ${v.label}`}
                  disabled={revert.isPending}
                  onClick={() => revert.mutate({ nodeId, versionId: v.id })}
                >
                  <RotateCcw />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Make this the current content</TooltipContent>
            </Tooltip>
          </div>
          <p className="text-muted-foreground text-xs">
            {v.createdBy} · {formatDate(v.created)} · {formatBytes(v.byteLength)}
          </p>
          {v.comment ? <p className="text-xs">{v.comment}</p> : null}
        </li>
      ))}
    </ul>
  );
}

function Notes({ nodeId, onChanged }: { nodeId: string; onChanged: () => void }) {
  const [text, setText] = useState('');
  const notes = trpc.workspace.notes.useQuery({ nodeId });
  const utils = trpc.useUtils();
  const add = trpc.workspace.addNote.useMutation({
    onSuccess() {
      setText('');
      void utils.workspace.notes.invalidate({ nodeId });
      onChanged();
    },
  });
  const remove = trpc.workspace.deleteNote.useMutation({
    onSuccess: () => utils.workspace.notes.invalidate({ nodeId }),
  });

  return (
    <div className="space-y-3">
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim()) add.mutate({ nodeId, notes: text });
        }}
      >
        <Textarea
          rows={3}
          placeholder="Add a note…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button type="submit" size="sm" disabled={!text.trim() || add.isPending}>
          {add.isPending ? <Loader2 className="animate-spin" /> : null}
          Add note
        </Button>
      </form>

      {add.error ? <InlineError message={add.error.message} /> : null}

      {(notes.data ?? []).length === 0 ? (
        <p className="text-muted-foreground text-sm">No notes yet.</p>
      ) : (
        <ul className="divide-y">
          {(notes.data ?? []).map((n) => (
            <li key={n.id} className="space-y-1 py-2.5">
              <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <span className="font-medium">{n.user.userName}</span>
                <span aria-hidden>·</span>
                <span>{formatDate(n.created)}</span>
                <span className="flex-1" />
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Delete note"
                  className="text-destructive hover:text-destructive"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate({ noteId: n.id })}
                >
                  <Trash2 />
                </Button>
              </div>
              <p className="text-sm whitespace-pre-wrap">{n.notes}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WorkflowHistory({ nodeId }: { nodeId: string }) {
  const instances = trpc.workflow.instancesForNode.useQuery({ nodeId });

  if (instances.isLoading) return <Skeleton className="h-16 w-full" />;
  if (instances.error) return <InlineError message={instances.error.message} />;
  if ((instances.data ?? []).length === 0) {
    return (
      <EmptyState
        className="border-0 px-0 py-4"
        icon={<Workflow />}
        title="No workflow has run"
        description="A trigger or a manual start puts this document through one."
      />
    );
  }

  return (
    <ul className="divide-y">
      {instances.data!.map((instance) => (
        <li key={instance.id} className="space-y-2 py-3 first:pt-0">
          <div className="flex items-center gap-2">
            <strong className="text-sm">{instance.workflow.name}</strong>
            <Badge
              variant={
                instance.state === 'completed'
                  ? 'success'
                  : instance.state === 'cancelled'
                    ? 'secondary'
                    : 'outline'
              }
            >
              {instance.state}
            </Badge>
          </div>
          <ol className="text-muted-foreground space-y-0.5 text-xs">
            {instance.todos.map((todo) => (
              <li key={todo.id} className="flex flex-wrap gap-x-1.5">
                <span className="text-foreground">{todo.task.name}</span>
                <span>— {todo.state}</span>
                {todo.decision ? <span>({todo.decision})</span> : null}
                {todo.assignedTo ? <span>· {todo.assignedTo.userName}</span> : null}
              </li>
            ))}
          </ol>
        </li>
      ))}
    </ul>
  );
}
