'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import { TriangleAlert } from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { TaskNodeData } from '@/lib/workflow/graph';
import { cn } from '@/lib/utils';

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
 * Task types the engine stops on, because each needs something this rebuild
 * does not ship (workflow-engine.ts `NEEDS_ENGINE`). Saying so on the node is
 * better than letting someone design a flow around a step that will halt the
 * instance the first time a document reaches it.
 */
export const UNIMPLEMENTED_TASKS = new Set([
  'rpa',
  'email',
  'signature',
  'stamp',
  'clone',
]);

/** Task types the engine runs itself, with no to-do for anyone. */
export const AUTOMATIC_TASKS = new Set(['notify', 'updateIndex', 'end']);

/**
 * The left edge carries the task type, so a flow is readable at a glance
 * without reading every label.
 */
const EDGE_TONE: Record<string, string> = {
  approval: 'border-l-primary',
  review: 'border-l-primary',
  decision: 'border-l-warning',
  end: 'border-l-destructive',
  notify: 'border-l-success',
  email: 'border-l-success',
};

export function TaskNode({ data, selected }: NodeProps) {
  const task = data as TaskNodeData;
  const assignees =
    (task.assigneeRoleIds?.length ?? 0) + (task.assigneeUserIds?.length ?? 0);
  const unimplemented = UNIMPLEMENTED_TASKS.has(task.type);

  return (
    <div
      className={cn(
        'bg-card text-card-foreground w-44 max-w-56 rounded-lg border border-l-4 px-2.5 py-2 text-xs shadow-sm transition-shadow',
        EDGE_TONE[task.type] ?? 'border-l-muted-foreground',
        selected && 'ring-primary/40 border-primary ring-2',
      )}
    >
      <Handle type="target" position={Position.Left} />

      <div className="text-muted-foreground flex items-center gap-1 text-[10px] font-semibold tracking-wider uppercase">
        {TASK_LABELS[task.type] ?? task.type}
        {unimplemented ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <TriangleAlert className="text-destructive size-3" />
            </TooltipTrigger>
            <TooltipContent>No handler in this rebuild</TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      <div className="mt-0.5 font-semibold break-words">
        {task.name || <em className="text-muted-foreground">Unnamed</em>}
      </div>

      <div className="text-muted-foreground mt-0.5 text-[11px]">
        {AUTOMATIC_TASKS.has(task.type)
          ? 'runs automatically'
          : `${
              assignees > 0
                ? `${assignees} assignee${assignees === 1 ? '' : 's'}`
                : 'anyone'
            }${task.allowSpecificReviewer ? ' · specific reviewer' : ''}`}
      </div>

      <Handle type="source" position={Position.Right} />
    </div>
  );
}

/** The terminator: an edge into it is a routing with `toTaskKey: null`. */
export function StopNode({ selected }: NodeProps) {
  return (
    <div
      className={cn(
        'bg-card text-muted-foreground rounded-full border border-dashed px-4 py-2 text-[11px] font-semibold tracking-widest uppercase',
        selected && 'ring-primary/40 border-primary ring-2',
      )}
    >
      <Handle type="target" position={Position.Left} />
      Stop
    </div>
  );
}

/** The start marker: its one outgoing edge names the task an instance begins at. */
export function StartNode({ selected }: NodeProps) {
  return (
    <div
      className={cn(
        'bg-card text-primary border-primary rounded-full border px-4 py-2 text-[11px] font-semibold tracking-widest uppercase',
        selected && 'ring-primary/40 ring-2',
      )}
    >
      Start
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const nodeTypes = { task: TaskNode, stop: StopNode, start: StartNode };
