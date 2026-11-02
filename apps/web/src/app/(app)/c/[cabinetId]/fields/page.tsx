'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';

const TYPES = [
  'text',
  'number',
  'decimal',
  'date',
  'datetime',
  'boolean',
  'selectList',
  'multiSelect',
  'autoNumber',
] as const;

type FieldType = (typeof TYPES)[number];

export default function FieldsPage() {
  const { cabinetId } = useParams<{ cabinetId: string }>();
  const utils = trpc.useUtils();
  const fields = trpc.indexField.list.useQuery({ cabinetId });

  const [label, setLabel] = useState('');
  const [type, setType] = useState<FieldType>('text');
  const [isRequired, setIsRequired] = useState(false);
  const [folderLevel, setFolderLevel] = useState(0);
  const [selectValues, setSelectValues] = useState('');

  function refresh() {
    void utils.indexField.list.invalidate({ cabinetId });
    void utils.indexField.columns.invalidate({ cabinetId });
  }

  const create = trpc.indexField.create.useMutation({
    onSuccess() {
      setLabel('');
      setSelectValues('');
      refresh();
    },
  });
  const remove = trpc.indexField.delete.useMutation({ onSuccess: refresh });

  const needsValues = type === 'selectList' || type === 'multiSelect';

  return (
    <>
      <h2>Index fields</h2>
      <p className="muted small">
        A cabinet&apos;s index fields define the metadata every document in it
        carries. A field with a folder level above zero also organises the tree.
      </p>

      <form
        className="card"
        style={{ marginBottom: 14, maxWidth: 620 }}
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate({
            cabinetId,
            label: label.trim(),
            type,
            isRequired,
            isRestricted: false,
            isLocked: false,
            folderLevel,
            sort: (fields.data?.length ?? 0) + 1,
            selectValues: needsValues
              ? selectValues
                  .split('\n')
                  .map((v) => v.trim())
                  .filter(Boolean)
              : undefined,
          });
        }}
      >
        <div className="field">
          <label htmlFor="label">Label</label>
          <input
            id="label"
            required
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>

        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="type">Type</label>
            <select
              id="type"
              value={type}
              onChange={(e) => setType(e.target.value as FieldType)}
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="folderLevel">Folder level (0 = not a folder level)</label>
            <input
              id="folderLevel"
              type="number"
              min={0}
              max={16}
              value={folderLevel}
              onChange={(e) => setFolderLevel(Number(e.target.value))}
            />
          </div>
        </div>

        {needsValues ? (
          <div className="field">
            <label htmlFor="values">Values, one per line</label>
            <textarea
              id="values"
              rows={4}
              required
              value={selectValues}
              onChange={(e) => setSelectValues(e.target.value)}
            />
          </div>
        ) : null}

        <label className="row small" style={{ marginBottom: 10 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={isRequired}
            onChange={(e) => setIsRequired(e.target.checked)}
          />
          Required
        </label>

        {create.error ? <p className="error small">{create.error.message}</p> : null}

        <button className="primary" type="submit" disabled={create.isPending}>
          Add field
        </button>
      </form>

      {remove.error ? <p className="error">{remove.error.message}</p> : null}

      <table>
        <thead>
          <tr>
            <th>Label</th>
            <th style={{ width: 110 }}>Type</th>
            <th style={{ width: 90 }}>Required</th>
            <th style={{ width: 110 }}>Folder level</th>
            <th style={{ width: 130 }}>Values</th>
            <th style={{ width: 90 }} />
          </tr>
        </thead>
        <tbody>
          {(fields.data ?? []).map((f) => (
            <tr key={f.id}>
              <td>
                {f.label}
                {f.isDefault ? <span className="pill" style={{ marginLeft: 6 }}>default</span> : null}
                {f.isLocked ? <span className="pill" style={{ marginLeft: 6 }}>locked</span> : null}
              </td>
              <td className="small muted">{f.type}</td>
              <td className="small muted">{f.isRequired ? 'Yes' : 'No'}</td>
              <td className="small muted">{f.folderLevel || '—'}</td>
              <td className="small muted">
                {f.selectValues.length > 0 ? `${f.selectValues.length} value(s)` : '—'}
              </td>
              <td>
                <button
                  className="danger small"
                  disabled={f.isDefault || f.isLocked}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Delete "${f.label}"? Every value stored in it is dropped.`,
                      )
                    ) {
                      remove.mutate({ fieldId: f.id });
                    }
                  }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
