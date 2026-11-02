'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { TaskNodeData } from '@/lib/workflow/graph';

/** Shorthand shown on the node, so the type is readable without the panel. */
const TASK_LABELS: Record<string, string> = {
  review: 'Review',
  approval: 'Approval',
  decision: 'Decision',
  notify: 'Notify',
  updateIndex: 'Update index',
  stamp: 'Stamp',
  signature: 'Signature',
  clone: 'Clone',
  email: 'Email',
  rpa: 'RPA',
  end: 'End',
};

/**
 * Task types the rebuild has no handler for. Dokmee ran these through engines
 * it licensed; saying so on the node is better than letting someone design a
 * flow around a step that will stall.
 */
export const UNIMPLEMENTED_TASKS = new Set(['rpa', 'email', 'signature']);

export function TaskNode({ data, selected }: NodeProps) {
  const task = data as TaskNodeData;
  const assignees = (task.assigneeRoleIds?.length ?? 0) + (task.assigneeUserIds?.length ?? 0);
  const unimplemented = UNIMPLEMENTED_TASKS.has(task.type);

  return (
    <div
      className="wf-node"
      data-type={task.type}
      data-selected={selected ? 'true' : undefined}
    >
      <Handle type="target" position={Position.Left} />
      <div className="wf-node-type">
        {TASK_LABELS[task.type] ?? task.type}
        {unimplemented ? <span className="wf-node-warn" title="No handler in this rebuild">!</span> : null}
      </div>
      <div className="wf-node-name">{task.name || <em>Unnamed</em>}</div>
      <div className="wf-node-meta">
        {assignees > 0 ? `${assignees} assignee${assignees === 1 ? '' : 's'}` : 'anyone'}
        {task.allowSpecificReviewer ? ' · specific reviewer' : ''}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

/** The terminator: an edge into it is a routing with `toTaskKey: null`. */
export function StopNode({ selected }: NodeProps) {
  return (
    <div className="wf-stop" data-selected={selected ? 'true' : undefined}>
      <Handle type="target" position={Position.Left} />
      Stop
    </div>
  );
}

/** The start marker: its one outgoing edge names the task an instance begins at. */
export function StartNode({ selected }: NodeProps) {
  return (
    <div className="wf-stop wf-start" data-selected={selected ? 'true' : undefined}>
      Start
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const nodeTypes = { task: TaskNode, stop: StopNode, start: StartNode };
