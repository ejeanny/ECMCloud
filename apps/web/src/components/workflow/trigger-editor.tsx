'use client';

import { Plus, Trash2 } from 'lucide-react';

import { storageSlotFor, type FieldType } from '@ecm/domain';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';

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
    <aside className="bg-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border">
      <div className="space-y-0.5 px-4 pt-4 pb-3">
        <h3 className="text-sm font-semibold">Trigger</h3>
        <p className="text-muted-foreground text-xs">
          What starts this workflow without anyone asking. With neither box ticked it runs
          only when someone starts it by hand.
        </p>
      </div>
      <Separator />

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-4">
          <div className="space-y-2">
            <label className="flex cursor-pointer items-center gap-2 text-xs">
              <Checkbox
                checked={value.onNewDocument}
                disabled={readOnly}
                onCheckedChange={(checked) =>
                  patch({ onNewDocument: checked === true })
                }
              />
              <span>When a document is added</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-xs">
              <Checkbox
                checked={value.onIndexChanged}
                disabled={readOnly}
                onCheckedChange={(checked) =>
                  patch({ onIndexChanged: checked === true })
                }
              />
              <span>When its index values change</span>
            </label>
          </div>

          {!armed ? (
            <p className="text-muted-foreground text-xs">
              Conditions below are kept, but nothing fires until one of these is ticked.
            </p>
          ) : null}

          <Separator />

          <div className="space-y-2">
            <Label>Only if</Label>

            {fields.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                This cabinet has no index fields to test.
              </p>
            ) : null}

            {value.clauses.length > 1 ? (
              <RadioGroup
                className="flex gap-4"
                value={value.combine}
                disabled={readOnly}
                onValueChange={(next) => patch({ combine: next as 'and' | 'or' })}
              >
                <label className="flex cursor-pointer items-center gap-2 text-xs">
                  <RadioGroupItem value="and" id="combine-and" />
                  <span>all of these</span>
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-xs">
                  <RadioGroupItem value="or" id="combine-or" />
                  <span>any of these</span>
                </label>
              </RadioGroup>
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
                <div
                  key={i}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-1.5"
                >
                  <Select
                    value={clause.fieldId}
                    disabled={readOnly}
                    onValueChange={(next) => {
                      const nextField = byId.get(next);
                      const allowed = nextField
                        ? operatorsFor(nextField.type)
                        : operators;
                      setClause(i, {
                        fieldId: next,
                        operator: allowed.some((o) => o.id === operator)
                          ? operator
                          : allowed[0]!.id,
                        value: '',
                      });
                    }}
                  >
                    <SelectTrigger size="sm" aria-label="Field">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {fields.map((f) => (
                        <SelectItem key={f.id} value={f.id}>
                          {f.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Select
                    value={operator}
                    disabled={readOnly}
                    onValueChange={(next) => setClause(i, { operator: next })}
                  >
                    <SelectTrigger size="sm" aria-label="Operator">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {operators.map((o) => (
                        <SelectItem key={o.id} value={o.id}>
                          {relabel(o.label, field.type)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {NO_VALUE.has(operator) ? (
                    <span className="text-muted-foreground self-center text-xs">—</span>
                  ) : field.type === 'boolean' ? (
                    <Select
                      value={String(clause.value ?? 'true')}
                      disabled={readOnly}
                      onValueChange={(next) => setClause(i, { value: next })}
                    >
                      <SelectTrigger size="sm" aria-label="Value">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="true">yes</SelectItem>
                        <SelectItem value="false">no</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      aria-label="Value"
                      className="h-8"
                      type={operator === 'in' ? 'text' : inputTypeFor(field.type)}
                      value={
                        Array.isArray(clause.value)
                          ? clause.value.join(', ')
                          : String(clause.value ?? '')
                      }
                      placeholder={operator === 'in' ? 'comma separated' : undefined}
                      disabled={readOnly}
                      onChange={(e) =>
                        setClause(i, {
                          value:
                            operator === 'in'
                              ? e.target.value
                                  .split(',')
                                  .map((s) => s.trim())
                                  .filter(Boolean)
                              : e.target.value,
                        })
                      }
                    />
                  )}

                  {!readOnly ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Remove condition"
                      className="text-destructive hover:text-destructive"
                      onClick={() =>
                        patch({ clauses: value.clauses.filter((_, j) => j !== i) })
                      }
                    >
                      <Trash2 />
                    </Button>
                  ) : null}
                </div>
              );
            })}

            {!readOnly && fields.length > 0 ? (
              <Button variant="outline" size="sm" onClick={addClause}>
                <Plus />
                Add condition
              </Button>
            ) : null}
          </div>

          <p className="text-muted-foreground text-xs">
            A condition tests an index value on the document, so a workflow can be
            narrowed to the invoices over a threshold rather than every file that lands in
            the cabinet.
          </p>
        </div>
      </ScrollArea>
    </aside>
  );
}
