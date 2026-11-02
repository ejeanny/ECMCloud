'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { formatBytes, formatDate, formatIndexValue } from '@/lib/format';
import { trpc } from '@/lib/trpc';

interface Props {
  nodeId: string;
  onChanged: () => void;
}

type Tab = 'index' | 'versions' | 'notes' | 'workflow';

/** The right-hand detail panel: index values, versions, notes, workflow. */
export function DocumentPanel({ nodeId, onChanged }: Props) {
  const [tab, setTab] = useState<Tab>('index');
  const detail = trpc.node.byId.useQuery({ nodeId });
  const utils = trpc.useUtils();
  const touch = trpc.workspace.touchRecent.useMutation();

  useEffect(() => {
    if (detail.data?.node.kind === 'document') touch.mutate({ nodeId });
    // Recording a view is a side effect of opening it, not of re-rendering.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, detail.data?.node.kind]);

  if (detail.isLoading) return <aside className="card muted">Loading…</aside>;
  if (detail.error) return <aside className="card error">{detail.error.message}</aside>;
  if (!detail.data) return null;

  const { node, index, checkedOutBy, versionCount, noteCount } = detail.data;

  function refresh() {
    void utils.node.byId.invalidate({ nodeId });
    onChanged();
  }

  return (
    <aside className="card" style={{ position: 'sticky', top: 20 }}>
      <h3 style={{ margin: '0 0 2px', wordBreak: 'break-word' }}>{node.name}</h3>
      <p className="small muted" style={{ marginTop: 0 }}>
        {node.kind === 'folder'
          ? 'Folder'
          : `${node.ext?.toUpperCase() ?? 'FILE'} · ${formatBytes(node.byteLength)}${
              node.pages ? ` · ${node.pages} pages` : ''
            }`}
      </p>

      {checkedOutBy ? (
        <p className="pill" style={{ marginBottom: 10 }}>
          Checked out by {checkedOutBy}
        </p>
      ) : null}

      {node.kind === 'document' ? (
        <div className="row wrap" style={{ marginBottom: 12 }}>
          {/* The viewer reads PDF. Dokmee converted everything to PDF first
              (`loadAsPDF`), which needs the conversion engine this rebuild does
              not ship — so anything else opens as its own bytes and lets the
              browser decide, rather than handing PDF.js a file it cannot parse. */}
          {node.ext?.toLowerCase() === 'pdf' ? (
            <Link className="pill" href={`/v/${node.id}`}>
              View &amp; annotate
            </Link>
          ) : (
            <a className="pill" href={`/file/${node.id}`} target="_blank" rel="noreferrer">
              View
            </a>
          )}
          <a className="pill" href={`/file/${node.id}/download`}>
            Download
          </a>
          <CheckOutControls
            nodeId={node.id}
            isCheckedOut={node.isCheckedOut}
            onChanged={refresh}
          />
        </div>
      ) : null}

      <div className="row small" style={{ marginBottom: 10 }}>
        {(
          [
            ['index', 'Index'],
            ['versions', `Versions (${versionCount})`],
            ['notes', `Notes (${noteCount})`],
            ['workflow', 'Workflow'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={
              tab === key
                ? { borderColor: 'var(--accent)', color: 'var(--accent)' }
                : undefined
            }
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'index' ? (
        <IndexForm nodeId={node.id} fields={index} onSaved={refresh} />
      ) : null}
      {tab === 'versions' ? <Versions nodeId={node.id} onChanged={refresh} /> : null}
      {tab === 'notes' ? <Notes nodeId={node.id} onChanged={refresh} /> : null}
      {tab === 'workflow' ? <WorkflowHistory nodeId={node.id} /> : null}

      <p className="small muted" style={{ marginTop: 14, marginBottom: 0 }}>
        Created {formatDate(node.created)} · modified {formatDate(node.modified)}
        {node.textExtractedAt ? ` · text extracted ${formatDate(node.textExtractedAt)}` : ''}
      </p>
    </aside>
  );
}

function CheckOutControls({
  nodeId,
  isCheckedOut,
  onChanged,
}: {
  nodeId: string;
  isCheckedOut: boolean;
  onChanged: () => void;
}) {
  const checkOut = trpc.version.checkOut.useMutation({ onSuccess: onChanged });
  const checkIn = trpc.version.checkIn.useMutation({ onSuccess: onChanged });
  const cancel = trpc.version.cancelCheckOut.useMutation({ onSuccess: onChanged });

  if (!isCheckedOut) {
    return (
      <button className="pill" onClick={() => checkOut.mutate({ nodeId })}>
        Check out
      </button>
    );
  }

  return (
    <>
      <button className="pill" onClick={() => checkIn.mutate({ nodeId, bump: 'minor' })}>
        Check in
      </button>
      <button className="pill danger" onClick={() => cancel.mutate({ nodeId })}>
        Cancel check-out
      </button>
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

  return (
    <form
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
      {fields.length === 0 ? (
        <p className="small muted">This cabinet has no index fields.</p>
      ) : null}

      {fields.map((f) => {
        const current = draft[f.fieldId] ?? forInput(f.type, f.value);
        return (
          <div className="field" key={f.fieldId}>
            <label htmlFor={`f-${f.fieldId}`}>
              {f.label}
              {f.isRequired ? ' *' : ''}
              {f.isLocked ? ' (locked)' : ''}
            </label>
            {f.isLocked ? (
              <p className="mono" style={{ margin: 0 }}>
                {formatIndexValue(f.value)}
              </p>
            ) : (
              <input
                id={`f-${f.fieldId}`}
                type={inputTypeFor(f.type)}
                value={current}
                required={f.isRequired}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, [f.fieldId]: e.target.value }))
                }
              />
            )}
          </div>
        );
      })}

      {save.error ? (
        <p className="error small" role="alert">
          {save.error.message}
        </p>
      ) : null}

      {fields.length > 0 ? (
        <div className="row">
          <button className="primary" type="submit" disabled={!dirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save index'}
          </button>
          {dirty ? (
            <button type="button" onClick={() => setDraft({})}>
              Discard
            </button>
          ) : null}
        </div>
      ) : null}
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

  if (versions.isLoading) return <p className="small muted">Loading…</p>;
  if (versions.error) return <p className="error small">{versions.error.message}</p>;
  if ((versions.data ?? []).length === 0) {
    return <p className="small muted">No earlier versions.</p>;
  }

  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {versions.data!.map((v) => (
        <li key={v.id} style={{ borderBottom: '1px solid var(--border)', padding: '6px 0' }}>
          <div className="row">
            <strong className="mono">{v.label}</strong>
            <span className="spacer" />
            <a
              className="pill"
              href={`/file/${nodeId}/download?version=${v.id}`}
              title={`Download version ${v.label}`}
            >
              Download
            </a>
            <button
              className="small"
              onClick={() => revert.mutate({ nodeId, versionId: v.id })}
            >
              Revert
            </button>
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            {v.createdBy} · {formatDate(v.created)} · {formatBytes(v.byteLength)}
          </p>
          {v.comment ? (
            <p className="small" style={{ margin: 0 }}>
              {v.comment}
            </p>
          ) : null}
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
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim()) add.mutate({ nodeId, notes: text });
        }}
      >
        <textarea
          rows={3}
          placeholder="Add a note…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button className="primary" type="submit" disabled={!text.trim() || add.isPending}>
          Add note
        </button>
      </form>

      {add.error ? <p className="error small">{add.error.message}</p> : null}

      <ul style={{ listStyle: 'none', padding: 0, marginTop: 10 }}>
        {(notes.data ?? []).map((n) => (
          <li key={n.id} style={{ borderTop: '1px solid var(--border)', padding: '6px 0' }}>
            <div className="row small muted">
              <span>{n.user.userName}</span>
              <span>·</span>
              <span>{formatDate(n.created)}</span>
              <span className="spacer" />
              <button className="danger" onClick={() => remove.mutate({ noteId: n.id })}>
                Delete
              </button>
            </div>
            <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{n.notes}</p>
          </li>
        ))}
      </ul>
    </>
  );
}

function WorkflowHistory({ nodeId }: { nodeId: string }) {
  const instances = trpc.workflow.instancesForNode.useQuery({ nodeId });

  if (instances.isLoading) return <p className="small muted">Loading…</p>;
  if (instances.error) return <p className="error small">{instances.error.message}</p>;
  if ((instances.data ?? []).length === 0) {
    return <p className="small muted">No workflow has run on this document.</p>;
  }

  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {instances.data!.map((instance) => (
        <li
          key={instance.id}
          style={{ borderTop: '1px solid var(--border)', padding: '8px 0' }}
        >
          <div className="row">
            <strong>{instance.workflow.name}</strong>
            <span className="pill">{instance.state}</span>
          </div>
          <ol className="small" style={{ paddingLeft: 18, margin: '4px 0 0' }}>
            {instance.todos.map((todo) => (
              <li key={todo.id}>
                {todo.task.name} — {todo.state}
                {todo.decision ? ` (${todo.decision})` : ''}
                {todo.assignedTo ? ` · ${todo.assignedTo.userName}` : ''}
              </li>
            ))}
          </ol>
        </li>
      ))}
    </ul>
  );
}
