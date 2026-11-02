'use client';

import { storageSlotFor, type FieldType } from '@ecm/domain';

export interface TriggerClause {
  fieldId: string;
  operator: string;
  value?: string | number | boolean | string[] | null;
}

export interface TriggerState {
  onNewDocument: boolean;
  onIndexChanged: boolean;
  combine: 'and' | 'or';
  clauses: TriggerClause[];
}

interface Field {
  id: string;
  label: string;
  type: FieldType;
}

interface Props {
  value: TriggerState;
  fields: Field[];
  readOnly: boolean;
  onChange: (next: TriggerState) => void;
}

/**
 * Which operators a field's type can actually answer.
 *
 * The clause compiler rejects the rest, and it only runs when a document
 * arrives — so offering `contains` on a date here would turn into a failed
 * upload later, nowhere near the workflow that caused it.
 */
function operatorsFor(type: FieldType): Array<{ id: string; label: string }> {
  const slot = storageSlotFor(type);
  const empty = [
    { id: 'isEmpty', label: 'is empty' },
    { id: 'isNotEmpty', label: 'is not empty' },
  ];

  if (slot === 'boolean') {
    return [
      { id: 'eq', label: 'is' },
      { id: 'neq', label: 'is not' },
      ...empty,
    ];
  }
  if (slot === 'number' || slot === 'date') {
    return [
      { id: 'eq', label: 'is' },
      { id: 'neq', label: 'is not' },
      { id: 'gt', label: 'is after' },
      { id: 'gte', label: 'is at or after' },
      { id: 'lt', label: 'is before' },
      { id: 'lte', label: 'is at or before' },
      ...empty,
    ];
  }
  return [
    { id: 'eq', label: 'is' },
    { id: 'neq', label: 'is not' },
    { id: 'contains', label: 'contains' },
    { id: 'startsWith', label: 'starts with' },
    { id: 'endsWith', label: 'ends with' },
    { id: 'in', label: 'is one of' },
    ...empty,
  ];
}

/** `gt` reads as "is after" on a date and "is greater than" on a number. */
function relabel(label: string, type: FieldType): string {
  if (storageSlotFor(type) !== 'number') return label;
  return label
    .replace('is after', 'is more than')
    .replace('is at or after', 'is at least')
    .replace('is before', 'is less than')
    .replace('is at or before', 'is at most');
}

function inputTypeFor(type: FieldType): string {
  switch (storageSlotFor(type)) {
    case 'number':
      return 'number';
    case 'date':
      return type === 'datetime' ? 'datetime-local' : 'date';
    default:
      return 'text';
  }
}

const NO_VALUE = new Set(['isEmpty', 'isNotEmpty']);

/**
 * The trigger: what starts this workflow on its own.
 *
 * Dokmee kept these in `Workflow_Triggers` + `Workflow_Trigger_Criteria`; the
 * conditions here are the same clause shape the row-level view restrictions
 * and the search use, so one compiler answers all three.
 */
export function TriggerEditor({ value, fields, readOnly, onChange }: Props) {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const armed = value.onNewDocument || value.onIndexChanged;

  function patch(next: Partial<TriggerState>) {
    onChange({ ...value, ...next });
  }

  function setClause(index: number, next: Partial<TriggerClause>) {
    patch({
      clauses: value.clauses.map((c, i) => (i === index ? { ...c, ...next } : c)),
    });
  }

  function addClause() {
    const field = fields[0];
    if (!field) return;
    patch({
      clauses: [...value.clauses, { fieldId: field.id, operator: 'eq', value: '' }],
    });
  }

  return (
    <aside className="card wf-inspector">
      <h3>Trigger</h3>
      <p className="small muted" style={{ marginTop: 0 }}>
        What starts this workflow without anyone asking. With neither box
        ticked it runs only when someone starts it by hand.
      </p>

      <div className="field">
        <label>
          <input
            type="checkbox"
            checked={value.onNewDocument}
            disabled={readOnly}
            onChange={(e) => patch({ onNewDocument: e.target.checked })}
          />{' '}
          When a document is added
        </label>
        <label>
          <input
            type="checkbox"
            checked={value.onIndexChanged}
            disabled={readOnly}
            onChange={(e) => patch({ onIndexChanged: e.target.checked })}
          />{' '}
          When its index values change
        </label>
      </div>

      {!armed ? (
        <p className="small muted">
          Conditions below are kept, but nothing fires until one of these is
          ticked.
        </p>
      ) : null}

      <div className="field">
        <label>Only if</label>
        {fields.length === 0 ? (
          <p className="small muted">This cabinet has no index fields to test.</p>
        ) : null}

        {value.clauses.length > 1 ? (
          <div className="row small" style={{ marginBottom: 6 }}>
            <label>
              <input
                type="radio"
                name="combine"
                checked={value.combine === 'and'}
                disabled={readOnly}
                onChange={() => patch({ combine: 'and' })}
              />{' '}
              all of these
            </label>
            <label>
              <input
                type="radio"
                name="combine"
                checked={value.combine === 'or'}
                disabled={readOnly}
                onChange={() => patch({ combine: 'or' })}
              />{' '}
              any of these
            </label>
          </div>
        ) : null}

        {value.clauses.map((clause, i) => {
          const field = byId.get(clause.fieldId) ?? fields[0];
          if (!field) return null;
          const operators = operatorsFor(field.type);
          // Switching field can leave an operator the new type cannot answer.
          const operator = operators.some((o) => o.id === clause.operator)
            ? clause.operator
            : operators[0]!.id;

          return (
            <div key={i} className="wf-clause">
              <select
                aria-label="Field"
                value={clause.fieldId}
                disabled={readOnly}
                onChange={(e) => {
                  const next = byId.get(e.target.value);
                  const allowed = next ? operatorsFor(next.type) : operators;
                  setClause(i, {
                    fieldId: e.target.value,
                    operator: allowed.some((o) => o.id === operator)
                      ? operator
                      : allowed[0]!.id,
                    value: '',
                  });
                }}
              >
                {fields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>

              <select
                aria-label="Operator"
                value={operator}
                disabled={readOnly}
                onChange={(e) => setClause(i, { operator: e.target.value })}
              >
                {operators.map((o) => (
                  <option key={o.id} value={o.id}>
                    {relabel(o.label, field.type)}
                  </option>
                ))}
              </select>

              {NO_VALUE.has(operator) ? (
                <span className="small muted">—</span>
              ) : field.type === 'boolean' ? (
                <select
                  aria-label="Value"
                  value={String(clause.value ?? 'true')}
                  disabled={readOnly}
                  onChange={(e) => setClause(i, { value: e.target.value })}
                >
                  <option value="true">yes</option>
                  <option value="false">no</option>
                </select>
              ) : (
                <input
                  aria-label="Value"
                  type={operator === 'in' ? 'text' : inputTypeFor(field.type)}
                  value={String(clause.value ?? '')}
                  placeholder={operator === 'in' ? 'comma separated' : undefined}
                  disabled={readOnly}
                  onChange={(e) =>
                    setClause(i, {
                      value:
                        operator === 'in'
                          ? e.target.value.split(',').map((s) => s.trim()).filter(Boolean)
                          : e.target.value,
                    })
                  }
                />
              )}

              {!readOnly ? (
                <button
                  className="danger"
                  aria-label="Remove condition"
                  onClick={() =>
                    patch({ clauses: value.clauses.filter((_, j) => j !== i) })
                  }
                >
                  ×
                </button>
              ) : null}
            </div>
          );
        })}

        {!readOnly && fields.length > 0 ? (
          <button onClick={addClause} style={{ marginTop: 6 }}>
            Add condition
          </button>
        ) : null}
      </div>

      <p className="small muted">
        A condition tests an index value on the document, so a workflow can be
        narrowed to the invoices over a threshold rather than every file that
        lands in the cabinet.
      </p>
    </aside>
  );
}
