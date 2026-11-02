'use client';

import { Info, MousePointerClick, Plus, Trash2, TriangleAlert } from 'lucide-react';

import { WORKFLOW_TASK_TYPES, ROUTING_TYPES, type RoutingType } from '@ecm/domain';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/states';
import type {
  DesignEdge,
  DesignNode,
  RoutingEdgeData,
  TaskNodeData,
} from '@/lib/workflow/graph';
import { START_NODE_ID, STOP_NODE_ID } from '@/lib/workflow/graph';
import { AUTOMATIC_TASKS, UNIMPLEMENTED_TASKS } from './nodes';

interface Props {
  node: DesignNode | null;
  edge: DesignEdge | null;
  roles: Array<{ id: string; name: string }>;
  users: Array<{ id: string; userName: string }>;
  fields: Array<{ id: string; label: string }>;
  onTaskChange: (key: string, patch: Partial<TaskNodeData>) => void;
  onEdgeChange: (id: string, patch: Partial<RoutingEdgeData>) => void;
  onDelete: () => void;
  readOnly: boolean;
}

const ROUTING_LABELS: Record<RoutingType, string> = {
  always: 'Always',
  onApprove: 'On approve',
  onReject: 'On reject',
  onDecision: 'On a choice',
};

/** The panel's own frame, so each branch below is just its contents. */
function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <aside className="bg-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border">
      <div className="space-y-0.5 px-4 pt-4 pb-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        {subtitle ? (
          <p className="text-muted-foreground text-xs break-words">{subtitle}</p>
        ) : null}
      </div>
      <Separator />
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-4">{children}</div>
      </ScrollArea>
    </aside>
  );
}

/** A scrollable list of checkboxes — roles or users to address. */
function Picker({
  options,
  selected,
  readOnly,
  emptyText,
  onToggle,
}: {
  options: Array<{ id: string; label: string }>;
  selected: string[];
  readOnly: boolean;
  emptyText: string;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="max-h-36 overflow-auto rounded-md border p-1 scrollbar-thin">
      {options.length === 0 ? (
        <p className="text-muted-foreground px-2 py-1.5 text-xs">{emptyText}</p>
      ) : null}
      {options.map((option) => (
        <label
          key={option.id}
          className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-xs"
        >
          <Checkbox
            checked={selected.includes(option.id)}
            disabled={readOnly}
            onCheckedChange={() => onToggle(option.id)}
          />
          <span className="min-w-0 truncate">{option.label}</span>
        </label>
      ))}
    </div>
  );
}

/** The panel beside the canvas: whatever is selected, edited in place. */
export function Inspector({
  node,
  edge,
  roles,
  users,
  fields,
  onTaskChange,
  onEdgeChange,
  onDelete,
  readOnly,
}: Props) {
  if (edge?.source === START_NODE_ID) {
    return (
      <Panel title="Start">
        <p className="text-muted-foreground text-xs">
          An instance begins at <strong className="text-foreground">{edge.target}</strong>.
          Drag the Start arrow to another task to begin there instead.
        </p>
        <p className="text-muted-foreground text-xs">
          This is marked rather than guessed because a rejection that sends the document
          back to the first reviewer leaves every task with an incoming arrow — and then
          there is nothing to guess from.
        </p>
      </Panel>
    );
  }

  if (edge) {
    const data = (edge.data ?? { type: 'always', decision: null }) as RoutingEdgeData;
    return (
      <Panel
        title="Routing"
        subtitle={
          <>
            {edge.source} → {edge.target === STOP_NODE_ID ? 'Stop' : edge.target}
          </>
        }
      >
        <div className="space-y-2">
          <Label htmlFor="routing-type">Taken when</Label>
          <Select
            value={data.type}
            disabled={readOnly}
            onValueChange={(value) =>
              onEdgeChange(edge.id, { type: value as RoutingType })
            }
          >
            <SelectTrigger id="routing-type" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROUTING_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {ROUTING_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {data.type === 'onDecision' ? (
          <div className="space-y-2">
            <Label htmlFor="routing-decision">Choice</Label>
            <Input
              id="routing-decision"
              value={data.decision ?? ''}
              disabled={readOnly}
              placeholder="e.g. Send to legal"
              onChange={(e) => onEdgeChange(edge.id, { decision: e.target.value })}
            />
            <p className="text-muted-foreground text-xs">
              Matched against the choice the reviewer picks, so it has to be exactly the
              wording they are offered.
            </p>
          </div>
        ) : null}

        <p className="text-muted-foreground text-xs">
          {data.type === 'always'
            ? 'Followed whenever no more specific routing matches.'
            : 'A more specific routing wins over Always.'}
        </p>

        {!readOnly ? (
          <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={onDelete}>
            <Trash2 />
            Delete routing
          </Button>
        ) : null}
      </Panel>
    );
  }

  if (!node || node.type !== 'task') {
    return (
      <Panel title="Nothing selected">
        <EmptyState
          className="border-0 px-0 py-2"
          icon={<MousePointerClick />}
          title="Pick a task or a routing"
          description="Drag from a task’s right edge to another task to route between them, or to Stop to end the flow there."
        />
      </Panel>
    );
  }

  const task = node.data as TaskNodeData;
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  const automatic = AUTOMATIC_TASKS.has(task.type);
  // Only `notify` has an audience among the automatic types; `end` and the
  // engine-bound ones address nobody, so the pickers would be noise.
  const showAudience = !automatic || task.type === 'notify';

  const configValues = Array.isArray((task.config as { values?: unknown })?.values)
    ? (task.config as { values: Array<{ fieldId: string; value: unknown }> }).values
    : [];

  function setValueAt(index: number, patch: Partial<{ fieldId: string; value: unknown }>) {
    onTaskChange(task.key, {
      config: {
        ...task.config,
        values: configValues.map((v, i) => (i === index ? { ...v, ...patch } : v)),
      },
    });
  }

  return (
    <Panel
      title="Task"
      subtitle={<span className="font-mono">{task.key}</span>}
    >
      <div className="space-y-2">
        <Label htmlFor="task-name">Name</Label>
        <Input
          id="task-name"
          value={task.name}
          disabled={readOnly}
          onChange={(e) => onTaskChange(task.key, { name: e.target.value })}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="task-type">Type</Label>
        <Select
          value={task.type}
          disabled={readOnly}
          onValueChange={(value) =>
            onTaskChange(task.key, { type: value as TaskNodeData['type'] })
          }
        >
          <SelectTrigger id="task-type" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WORKFLOW_TASK_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
                {UNIMPLEMENTED_TASKS.has(t) ? (
                  <Badge variant="outline">no handler</Badge>
                ) : null}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {UNIMPLEMENTED_TASKS.has(task.type) ? (
          <Alert variant="warning">
            <TriangleAlert />
            <AlertDescription>
              This rebuild has no handler for this type — Dokmee ran it through an engine
              it licensed. An instance reaching it will stall.
            </AlertDescription>
          </Alert>
        ) : null}
      </div>

      {task.type === 'notify' ? (
        <div className="space-y-2">
          <Label htmlFor="task-message">Message</Label>
          <Textarea
            id="task-message"
            rows={2}
            value={String((task.config as { message?: unknown })?.message ?? '')}
            disabled={readOnly}
            placeholder="Left empty, it says the step ran on the document."
            onChange={(e) =>
              onTaskChange(task.key, {
                config: { ...task.config, message: e.target.value },
              })
            }
          />
        </div>
      ) : null}

      {task.type === 'updateIndex' ? (
        <div className="space-y-2">
          <Label>Set these values</Label>
          {fields.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              This cabinet has no index fields.
            </p>
          ) : null}

          {configValues.map((v, i) => (
            <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-1.5">
              <Select
                value={v.fieldId}
                disabled={readOnly}
                onValueChange={(value) => setValueAt(i, { fieldId: value })}
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
              <Input
                aria-label="Value"
                className="h-8"
                value={String(v.value ?? '')}
                disabled={readOnly}
                onChange={(e) => setValueAt(i, { value: e.target.value })}
              />
              {!readOnly ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove value"
                  className="text-destructive hover:text-destructive"
                  onClick={() =>
                    onTaskChange(task.key, {
                      config: {
                        ...task.config,
                        values: configValues.filter((_, j) => j !== i),
                      },
                    })
                  }
                >
                  <Trash2 />
                </Button>
              ) : null}
            </div>
          ))}

          {!readOnly && fields.length > 0 ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                onTaskChange(task.key, {
                  config: {
                    ...task.config,
                    values: [...configValues, { fieldId: fields[0]!.id, value: '' }],
                  },
                })
              }
            >
              <Plus />
              Add value
            </Button>
          ) : null}

          <p className="text-muted-foreground text-xs">
            Written by the workflow, so a locked field is allowed — that is usually the
            point. Setting a value here does not re-trigger index-change workflows.
          </p>
        </div>
      ) : null}

      {automatic ? (
        <Alert variant="info">
          <Info />
          <AlertDescription>
            This step runs by itself and moves straight on; it waits for nobody.
            {task.type === 'notify'
              ? ' Anyone chosen below is who it tells — with nobody chosen, it tells whoever filed the document.'
              : ''}
          </AlertDescription>
        </Alert>
      ) : null}

      {!automatic ? (
        <label className="flex cursor-pointer items-start gap-2 text-xs">
          <Checkbox
            checked={task.allowSpecificReviewer}
            disabled={readOnly}
            onCheckedChange={(checked) =>
              onTaskChange(task.key, { allowSpecificReviewer: checked === true })
            }
          />
          <span>Let the starter name a specific reviewer</span>
        </label>
      ) : null}

      {showAudience ? (
        <>
          <div className="space-y-2">
            <Label>{task.type === 'notify' ? 'Tell these roles' : 'Assign to roles'}</Label>
            <Picker
              options={roles.map((r) => ({ id: r.id, label: r.name }))}
              selected={task.assigneeRoleIds}
              readOnly={readOnly}
              emptyText="No roles."
              onToggle={(id) =>
                onTaskChange(task.key, {
                  assigneeRoleIds: toggle(task.assigneeRoleIds, id),
                })
              }
            />
          </div>

          <div className="space-y-2">
            <Label>{task.type === 'notify' ? 'Tell these users' : 'Assign to users'}</Label>
            <Picker
              options={users.map((u) => ({ id: u.id, label: u.userName }))}
              selected={task.assigneeUserIds}
              readOnly={readOnly}
              emptyText="No users."
              onToggle={(id) =>
                onTaskChange(task.key, {
                  assigneeUserIds: toggle(task.assigneeUserIds, id),
                })
              }
            />
            <p className="text-muted-foreground text-xs">
              {task.type === 'notify'
                ? 'With nobody chosen it tells whoever filed the document.'
                : 'With nothing chosen the task is open to anyone who can see the document.'}
            </p>
          </div>
        </>
      ) : null}

      {!readOnly ? (
        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 />
          Delete task
        </Button>
      ) : null}
    </Panel>
  );
}
