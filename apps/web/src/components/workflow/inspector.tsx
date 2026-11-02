'use client';

import { WORKFLOW_TASK_TYPES, ROUTING_TYPES, type RoutingType } from '@ecm/domain';
import type {
  DesignEdge,
  DesignNode,
  RoutingEdgeData,
  TaskNodeData,
} from '@/lib/workflow/graph';
import { START_NODE_ID, STOP_NODE_ID } from '@/lib/workflow/graph';
import { UNIMPLEMENTED_TASKS } from './nodes';

interface Props {
  node: DesignNode | null;
  edge: DesignEdge | null;
  roles: Array<{ id: string; name: string }>;
  users: Array<{ id: string; userName: string }>;
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

      <div className="field">
        <label>Assign to roles</label>
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
        <label>Assign to users</label>
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
          With nothing chosen the task is open to anyone who can see the
          document.
        </p>
      </div>

      {!readOnly ? (
        <button className="danger" onClick={onDelete}>
          Delete task
        </button>
      ) : null}
    </aside>
  );
}
