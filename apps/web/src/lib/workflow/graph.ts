import type { Edge, Node } from '@xyflow/react';
import type { RoutingType, WorkflowTaskType } from '@ecm/domain';

/**
 * The translation between a saved workflow and the canvas.
 *
 * Dokmee's designer was Rappid/JointJS; this is React Flow over the same graph
 * the engine already runs — tasks joined by routings, each routing carrying the
 * condition under which it is taken. Nothing here invents a concept the server
 * does not have, so a workflow drawn on the canvas and one posted to
 * `workflow.save` by hand are the same thing.
 */

export interface DesignTask {
  key: string;
  name: string;
  type: WorkflowTaskType;
  allowSpecificReviewer: boolean;
  config: Record<string, unknown>;
  assigneeRoleIds: string[];
  assigneeUserIds: string[];
  x?: number | null;
  y?: number | null;
}

/**
 * A task that has been on the canvas, so its position is known. Reading a
 * workflow can yield tasks without one (saved through the API); leaving the
 * canvas cannot.
 */
export type PositionedTask = Omit<DesignTask, 'x' | 'y'> & { x: number; y: number };

export interface DesignRouting {
  fromTaskKey: string;
  toTaskKey: string | null;
  type: RoutingType;
  decision: string | null;
  order: number;
}

export type TaskNodeData = Omit<DesignTask, 'x' | 'y'> & Record<string, unknown>;
export type RoutingEdgeData = { type: RoutingType; decision: string | null } & Record<
  string,
  unknown
>;

export type DesignNode = Node<TaskNodeData | Record<string, unknown>>;
export type DesignEdge = Edge<RoutingEdgeData>;

/**
 * The terminator. A routing with `toTaskKey: null` stops the instance, and an
 * edge has to point *somewhere*, so termination gets a node of its own — which
 * also makes "stop here" something you can draw rather than something you have
 * to know about.
 */
export const STOP_NODE_ID = '__stop__';

/**
 * The start marker. Its single outgoing edge names the entry task.
 *
 * Inferring the entry as "the task nothing routes to" breaks on the commonest
 * approval shape there is — reject sends the document back to the first
 * reviewer, so every task has an incoming edge and nothing can start. Drawing
 * the start makes it explicit and the loop legal.
 */
export const START_NODE_ID = '__start__';

const COLUMN = 260;
const ROW = 130;

/**
 * Lay out a graph that has no stored positions: tasks are placed in the column
 * of their longest path from an entry task, which puts the flow left-to-right
 * and keeps a branch's two sides apart.
 */
export function autoLayout(
  tasks: readonly DesignTask[],
  routings: readonly DesignRouting[],
): Map<string, { x: number; y: number }> {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const next = new Map<string, string[]>();
  const indegree = new Map<string, number>(tasks.map((t) => [t.key, 0]));

  for (const r of routings) {
    if (!r.toTaskKey || !byKey.has(r.fromTaskKey) || !byKey.has(r.toTaskKey)) continue;
    next.set(r.fromTaskKey, [...(next.get(r.fromTaskKey) ?? []), r.toTaskKey]);
    indegree.set(r.toTaskKey, (indegree.get(r.toTaskKey) ?? 0) + 1);
  }

  const column = new Map<string, number>();
  const queue = tasks.filter((t) => (indegree.get(t.key) ?? 0) === 0).map((t) => t.key);
  // A graph that is all cycle has no entry; start somewhere so it still draws.
  if (queue.length === 0 && tasks[0]) queue.push(tasks[0].key);
  for (const key of queue) column.set(key, 0);

  // Longest-path layering, with a visit cap so a cycle cannot spin.
  const limit = tasks.length * tasks.length + tasks.length;
  let visits = 0;
  while (queue.length > 0 && visits < limit) {
    visits += 1;
    const key = queue.shift()!;
    const here = column.get(key) ?? 0;
    for (const target of next.get(key) ?? []) {
      if ((column.get(target) ?? -1) >= here + 1) continue;
      column.set(target, here + 1);
      queue.push(target);
    }
  }

  const rows = new Map<number, number>();
  const placed = new Map<string, { x: number; y: number }>();
  for (const task of tasks) {
    const col = column.get(task.key) ?? 0;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    placed.set(task.key, { x: col * COLUMN, y: row * ROW });
  }
  return placed;
}

/** Where to put the stop node: one column past the furthest task. */
function stopPosition(positions: Map<string, { x: number; y: number }>) {
  let maxX = 0;
  for (const p of positions.values()) maxX = Math.max(maxX, p.x);
  return { x: maxX + COLUMN, y: 0 };
}

export function toGraph(
  tasks: readonly DesignTask[],
  routings: readonly DesignRouting[],
  entryTaskKey?: string | null,
): { nodes: DesignNode[]; edges: DesignEdge[] } {
  // Stored positions win; anything missing is laid out, so a graph built
  // through the API still opens as a readable diagram.
  const fallback = autoLayout(tasks, routings);
  const positions = new Map<string, { x: number; y: number }>();
  for (const task of tasks) {
    positions.set(
      task.key,
      task.x === null || task.x === undefined || task.y === null || task.y === undefined
        ? fallback.get(task.key) ?? { x: 0, y: 0 }
        : { x: task.x, y: task.y },
    );
  }

  const nodes: DesignNode[] = tasks.map((task) => ({
    id: task.key,
    type: 'task',
    position: positions.get(task.key)!,
    data: {
      key: task.key,
      name: task.name,
      type: task.type,
      allowSpecificReviewer: task.allowSpecificReviewer,
      config: task.config,
      assigneeRoleIds: task.assigneeRoleIds,
      assigneeUserIds: task.assigneeUserIds,
    },
  }));

  nodes.push({
    id: STOP_NODE_ID,
    type: 'stop',
    position: stopPosition(positions),
    data: {},
    deletable: false,
  });

  let minX = 0;
  let minY = 0;
  for (const p of positions.values()) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
  }
  nodes.push({
    id: START_NODE_ID,
    type: 'start',
    position: { x: minX - COLUMN, y: minY },
    data: {},
    deletable: false,
  });

  const edges: DesignEdge[] = routings.map((r, i) => ({
    id: `${r.fromTaskKey}->${r.toTaskKey ?? STOP_NODE_ID}#${i}`,
    source: r.fromTaskKey,
    target: r.toTaskKey ?? STOP_NODE_ID,
    data: { type: r.type, decision: r.decision },
  }));

  // The entry is shown as an edge so it is drawn, moved and re-pointed like
  // everything else. An unsaved entry falls back to the engine's inference, so
  // the marker never sits unconnected on a graph that would in fact start.
  const entry =
    entryTaskKey && tasks.some((t) => t.key === entryTaskKey)
      ? entryTaskKey
      : inferredEntry(tasks, routings);
  if (entry) {
    edges.push({
      id: `${START_NODE_ID}->${entry}`,
      source: START_NODE_ID,
      target: entry,
      data: { type: 'always', decision: null },
    });
  }

  return { nodes, edges };
}

function inferredEntry(
  tasks: readonly DesignTask[],
  routings: readonly DesignRouting[],
): string | null {
  const targets = new Set(routings.flatMap((r) => (r.toTaskKey ? [r.toTaskKey] : [])));
  return tasks.find((t) => !targets.has(t.key))?.key ?? null;
}

export function fromGraph(
  nodes: readonly DesignNode[],
  edges: readonly DesignEdge[],
): { tasks: PositionedTask[]; routings: DesignRouting[]; entryTaskKey: string | null } {
  const tasks: PositionedTask[] = nodes
    .filter((n) => n.type === 'task')
    .map((n) => {
      const data = n.data as TaskNodeData;
      return {
        key: data.key,
        name: data.name,
        type: data.type,
        allowSpecificReviewer: data.allowSpecificReviewer,
        config: data.config ?? {},
        assigneeRoleIds: data.assigneeRoleIds ?? [],
        assigneeUserIds: data.assigneeUserIds ?? [],
        x: n.position.x,
        y: n.position.y,
      };
    });

  // The start edge names the entry task; it is not a routing.
  const entryTaskKey = edges.find((e) => e.source === START_NODE_ID)?.target ?? null;

  // `order` is the engine's tie-breaker among a task's routings, so it has to
  // be per source rather than a running index over the whole list.
  const perSource = new Map<string, number>();
  const routings: DesignRouting[] = edges
    .filter((e) => e.source !== START_NODE_ID)
    .map((e) => {
      const order = perSource.get(e.source) ?? 0;
      perSource.set(e.source, order + 1);
      const data = (e.data ?? { type: 'always', decision: null }) as RoutingEdgeData;
      return {
        fromTaskKey: e.source,
        toTaskKey: e.target === STOP_NODE_ID ? null : e.target,
        type: data.type,
        decision: data.type === 'onDecision' ? data.decision : null,
        order,
      };
    });

  return { tasks, routings, entryTaskKey };
}

/** A key that is stable, readable in the API, and unique in this graph. */
export function nextKey(type: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  for (let i = 1; ; i += 1) {
    const key = `${type}-${i}`;
    if (!taken.has(key)) return key;
  }
}

// --- problems worth blocking a save ---------------------------------------

export interface GraphProblem {
  /** The node or edge it belongs to, for highlighting. */
  id: string;
  message: string;
}

/**
 * The checks the server also makes, run here so the designer can point at the
 * offending node instead of showing a sentence after a failed round trip.
 */
export function problemsIn(
  nodes: readonly DesignNode[],
  edges: readonly DesignEdge[],
): GraphProblem[] {
  const problems: GraphProblem[] = [];
  const tasks = nodes.filter((n) => n.type === 'task');

  if (tasks.length === 0) {
    problems.push({ id: STOP_NODE_ID, message: 'A workflow needs at least one task.' });
  }

  const startEdges = edges.filter((e) => e.source === START_NODE_ID);
  if (tasks.length > 0 && startEdges.length === 0) {
    problems.push({
      id: START_NODE_ID,
      message: 'Nothing is marked as the start: drag from Start to the first task.',
    });
  }
  if (startEdges.length > 1) {
    problems.push({
      id: START_NODE_ID,
      message: 'A workflow starts at one task; remove the extra start arrows.',
    });
  }

  const seen = new Map<string, string>();
  for (const edge of edges.filter((e) => e.source !== START_NODE_ID)) {
    const data = (edge.data ?? {}) as RoutingEdgeData;
    if (data.type === 'onDecision' && !data.decision?.trim()) {
      problems.push({ id: edge.id, message: 'This decision routing has no choice on it.' });
    }
    const condition = `${edge.source}\u0000${data.type}\u0000${data.decision ?? ''}`;
    const prior = seen.get(condition);
    if (prior) {
      problems.push({
        id: edge.id,
        message: `Same condition as another routing out of "${edge.source}"; which one runs would depend on their order.`,
      });
    }
    seen.set(condition, edge.id);
  }

  for (const node of tasks) {
    const data = node.data as TaskNodeData;
    if (!data.name?.trim()) {
      problems.push({ id: node.id, message: 'This task has no name.' });
    }
    // A decision task whose branches are not drawn can only ever fall through
    // to its `always` edge, which is unlikely to be what the designer meant.
    if (
      data.type === 'decision' &&
      !edges.some(
        (e) =>
          e.source === node.id && (e.data as RoutingEdgeData | undefined)?.type === 'onDecision',
      )
    ) {
      problems.push({
        id: node.id,
        message: 'A decision task with no decision routings can never branch.',
      });
    }
  }

  return problems;
}
