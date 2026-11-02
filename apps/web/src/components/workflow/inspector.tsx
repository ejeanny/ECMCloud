'use client';

import { WORKFLOW_TASK_TYPES, ROUTING_TYPES, type RoutingType } from '@ecm/domain';
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
      <aside className="card wf-inspector">
        <h3>Start</h3>
        <p className="small muted">
          An instance begins at <strong>{edge.target}</strong>. Drag the Start
          arrow to another task to begin there instead.
        </p>
        <p className="small muted">
          This is marked rather than guessed because a rejection that sends the
          document back to the first reviewer leaves every task with an incoming
          arrow — and then there is nothing to guess from.
        </p>
      </aside>
    );
  }

  if (edge) {
    const data = (edge.data ?? { type: 'always', decision: null }) as RoutingEdgeData;
    return (
      <aside className="card wf-inspector">
        <h3>Routing</h3>
        <p className="small muted" style={{ marginTop: 0 }}>
          {edge.source} → {edge.target === STOP_NODE_ID ? 'Stop' : edge.target}
        </p>

        <div className="field">
          <label htmlFor="routing-type">Taken when</label>
          <select
            id="routing-type"
            value={data.type}
            disabled={readOnly}
            onChange={(e) =>
              onEdgeChange(edge.id, { type: e.target.value as RoutingType })
            }
          >
            {ROUTING_TYPES.map((t) => (
              <option key={t} value={t}>
                {ROUTING_LABELS[t]}
              </option>
            ))}
          </select>
        </div>

        {data.type === 'onDecision' ? (
          <div className="field">
            <label htmlFor="routing-decision">Choice</label>
            <input
              id="routing-decision"
              value={data.decision ?? ''}
              disabled={readOnly}
              placeholder="e.g. Send to legal"
              onChange={(e) => onEdgeChange(edge.id, { decision: e.target.value })}
            />
            <p className="small muted" style={{ margin: '4px 0 0' }}>
              Matched against the choice the reviewer picks, so it has to be
              exactly the wording they are offered.
            </p>
          </div>
        ) : null}

        <p className="small muted">
          {data.type === 'always'
            ? 'Followed whenever no more specific routing matches.'
            : 'A more specific routing wins over Always.'}
        </p>

        {!readOnly ? (
          <button className="danger" onClick={onDelete}>
            Delete routing
          </button>
        ) : null}
      </aside>
    );
  }

  if (!node || node.type !== 'task') {
    return (
      <aside className="card wf-inspector">
        <h3>Nothing selected</h3>
        <p className="small muted">
          Pick a task or a routing to edit it. Drag from a task&apos;s right edge
          to another task to route between them, or to <strong>Stop</strong> to
          end the flow there.
        </p>
      </aside>
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
    ? ((task.config as { values: Array<{ fieldId: string; value: unknown }> }).values)
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
    <aside className="card wf-inspector">
      <h3>Task</h3>
      <p className="small muted mono" style={{ marginTop: 0 }}>
        {task.key}
      </p>

      <div className="field">
        <label htmlFor="task-name">Name</label>
        <input
          id="task-name"
          value={task.name}
          disabled={readOnly}
          onChange={(e) => onTaskChange(task.key, { name: e.target.value })}
        />
      </div>

      <div className="field">
        <label htmlFor="task-type">Type</label>
        <select
          id="task-type"
          value={task.type}
          disabled={readOnly}
          onChange={(e) =>
            onTaskChange(task.key, { type: e.target.value as TaskNodeData['type'] })
          }
        >
          {WORKFLOW_TASK_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
              {UNIMPLEMENTED_TASKS.has(t) ? ' (no handler)' : ''}
            </option>
          ))}
        </select>
        {UNIMPLEMENTED_TASKS.has(task.type) ? (
          <p className="small muted" style={{ margin: '4px 0 0' }}>
            This rebuild has no handler for this type — Dokmee ran it through an
            engine it licensed. An instance reaching it will stall.
          </p>
        ) : null}
      </div>

      {task.type === 'notify' ? (
        <div className="field">
          <label htmlFor="task-message">Message</label>
          <textarea
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
        <div className="field">
          <label>Set these values</label>
          {fields.length === 0 ? (
            <p className="small muted">This cabinet has no index fields.</p>
          ) : null}
          {configValues.map((v, i) => (
            <div key={i} className="wf-clause wf-clause-pair">
              <select
                aria-label="Field"
                value={v.fieldId}
                disabled={readOnly}
                onChange={(e) => setValueAt(i, { fieldId: e.target.value })}
              >
                {fields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
              <input
                aria-label="Value"
                value={String(v.value ?? '')}
                disabled={readOnly}
                onChange={(e) => setValueAt(i, { value: e.target.value })}
              />
              {!readOnly ? (
                <button
                  className="danger"
                  aria-label="Remove value"
                  onClick={() =>
                    onTaskChange(task.key, {
                      config: {
                        ...task.config,
                        values: configValues.filter((_, j) => j !== i),
                      },
                    })
                  }
                >
                  ×
                </button>
              ) : null}
            </div>
          ))}
          {!readOnly && fields.length > 0 ? (
            <button
              style={{ marginTop: 4 }}
              onClick={() =>
                onTaskChange(task.key, {
                  config: {
                    ...task.config,
                    values: [...configValues, { fieldId: fields[0]!.id, value: '' }],
                  },
                })
              }
            >
              Add value
            </button>
          ) : null}
          <p className="small muted" style={{ margin: '4px 0 0' }}>
            Written by the workflow, so a locked field is allowed — that is
            usually the point. Setting a value here does not re-trigger
            index-change workflows.
          </p>
        </div>
      ) : null}

      {automatic ? (
        <p className="small muted">
          This step runs by itself and moves straight on; it waits for nobody.
          {task.type === 'notify'
            ? ' Anyone chosen below is who it tells — with nobody chosen, it tells whoever filed the document.'
            : ''}
        </p>
      ) : null}

      {!automatic ? (
        <div className="field">
          <label>
            <input
              type="checkbox"
              checked={task.allowSpecificReviewer}
              disabled={readOnly}
              onChange={(e) =>
                onTaskChange(task.key, { allowSpecificReviewer: e.target.checked })
              }
            />{' '}
            Let the starter name a specific reviewer
          </label>
        </div>
      ) : null}

      {showAudience ? (
      <>
      <div className="field">
        <label>{task.type === 'notify' ? 'Tell these roles' : 'Assign to roles'}</label>
        <div className="wf-picker">
          {roles.length === 0 ? <p className="small muted">No roles.</p> : null}
          {roles.map((r) => (
            <label key={r.id} className="small">
              <input
                type="checkbox"
                checked={task.assigneeRoleIds.includes(r.id)}
                disabled={readOnly}
                onChange={() =>
                  onTaskChange(task.key, {
                    assigneeRoleIds: toggle(task.assigneeRoleIds, r.id),
                  })
                }
              />{' '}
              {r.name}
            </label>
          ))}
        </div>
      </div>

      <div className="field">
        <label>{task.type === 'notify' ? 'Tell these users' : 'Assign to users'}</label>
        <div className="wf-picker">
          {users.map((u) => (
            <label key={u.id} className="small">
              <input
                type="checkbox"
                checked={task.assigneeUserIds.includes(u.id)}
                disabled={readOnly}
                onChange={() =>
                  onTaskChange(task.key, {
                    assigneeUserIds: toggle(task.assigneeUserIds, u.id),
                  })
                }
              />{' '}
              {u.userName}
            </label>
          ))}
        </div>
        <p className="small muted" style={{ margin: '4px 0 0' }}>
          {task.type === 'notify'
            ? 'With nobody chosen it tells whoever filed the document.'
            : 'With nothing chosen the task is open to anyone who can see the document.'}
        </p>
      </div>
      </>
      ) : null}

      {!readOnly ? (
        <button className="danger" onClick={onDelete}>
          Delete task
        </button>
      ) : null}
    </aside>
  );
}
