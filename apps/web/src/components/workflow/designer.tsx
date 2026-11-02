'use client';

import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type EdgeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { WORKFLOW_TASK_TYPES, type RoutingType, type WorkflowTaskType } from '@ecm/domain';
import {
  START_NODE_ID,
  STOP_NODE_ID,
  autoLayout,
  fromGraph,
  nextKey,
  problemsIn,
  toGraph,
  type DesignEdge,
  type DesignNode,
  type DesignRouting,
  type DesignTask,
  type RoutingEdgeData,
  type TaskNodeData,
} from '@/lib/workflow/graph';
import { trpc } from '@/lib/trpc';
import { Inspector } from './inspector';
import { nodeTypes } from './nodes';

interface Props {
  cabinetId: string;
  workflowId?: string;
  initial: {
    name: string;
    description: string | null;
    revision: number | null;
    published: boolean;
    tasks: DesignTask[];
    routings: DesignRouting[];
    entryTaskKey: string | null;
    /**
     * Carried through a save untouched. Saving creates a whole revision, so
     * omitting it here would silently clear the trigger that starts the
     * workflow — the graph would be right and nothing would ever run it.
     */
    trigger: {
      onNewDocument: boolean;
      onIndexChanged: boolean;
      combine: 'and' | 'or';
      clauses: unknown[];
    };
  };
  readOnly: boolean;
  onSaved: (result: { workflowId: string; revision: number }) => void;
}

/** How an edge is drawn, by the condition it carries. */
const EDGE_STYLE: Record<RoutingType, { stroke: string; label: (d: string | null) => string }> = {
  always: { stroke: 'var(--text-dim)', label: () => '' },
  onApprove: { stroke: 'var(--ok)', label: () => 'approve' },
  onReject: { stroke: 'var(--danger)', label: () => 'reject' },
  onDecision: { stroke: 'var(--accent)', label: (d) => d || '(no choice)' },
};

const edgeTypes: EdgeTypes = {};

export function WorkflowDesigner({
  cabinetId,
  workflowId,
  initial,
  readOnly,
  onSaved,
}: Props) {
  const graph = useMemo(
    () => toGraph(initial.tasks, initial.routings, initial.entryTaskKey),
    [initial.tasks, initial.routings, initial.entryTaskKey],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<DesignNode>(graph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<DesignEdge>(graph.edges);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? '');
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const assignees = trpc.workflow.assignees.useQuery({ cabinetId });
  const utils = trpc.useUtils();

  const save = trpc.workflow.save.useMutation({
    onSuccess(result) {
      setDirty(false);
      void utils.workflow.list.invalidate({ cabinetId });
      if (workflowId) void utils.workflow.byId.invalidate({ workflowId });
      onSaved(result);
    },
  });

  const publish = trpc.workflow.publish.useMutation({
    onSuccess() {
      void utils.workflow.list.invalidate({ cabinetId });
      if (workflowId) void utils.workflow.byId.invalidate({ workflowId });
    },
  });

  // Reload when the caller swaps in another revision.
  useEffect(() => {
    setNodes(graph.nodes);
    setEdges(graph.edges);
    setDirty(false);
  }, [graph, setNodes, setEdges]);

  const problems = useMemo(() => problemsIn(nodes, edges), [nodes, edges]);
  const problemIds = useMemo(() => new Set(problems.map((p) => p.id)), [problems]);

  const touched = useCallback(() => setDirty(true), []);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (readOnly) return;
      // Nothing routes out of Stop, and a task routing to itself would loop
      // the instance on one step forever.
      if (connection.source === STOP_NODE_ID) return;
      if (connection.source === connection.target) return;
      // Start points at exactly one task, so re-pointing it moves the arrow
      // rather than adding a second one.
      if (connection.source === START_NODE_ID && connection.target === START_NODE_ID) return;
      setEdges((current) =>
        addEdge<DesignEdge>(
          { ...connection, data: { type: 'always', decision: null } },
          connection.source === START_NODE_ID
            ? current.filter((e) => e.source !== START_NODE_ID)
            : current,
        ),
      );
      touched();
    },
    [readOnly, setEdges, touched],
  );

  function addTask(type: WorkflowTaskType) {
    const key = nextKey(type, nodes.map((n) => n.id));
    const node: DesignNode = {
      id: key,
      type: 'task',
      // Dropped clear of the existing graph rather than on top of it.
      position: {
        x: Math.max(0, ...nodes.map((n) => n.position.x)) + 60,
        y: Math.max(0, ...nodes.map((n) => n.position.y)) + 150,
      },
      data: {
        key,
        name: `New ${type}`,
        type,
        allowSpecificReviewer: false,
        config: {},
        assigneeRoleIds: [],
        assigneeUserIds: [],
      },
    };
    setNodes((current) => [...current, node]);
    setSelectedNode(key);
    setSelectedEdge(null);
    touched();
  }

  function onTaskChange(key: string, patch: Partial<TaskNodeData>) {
    setNodes((current) =>
      current.map((n) => (n.id === key ? { ...n, data: { ...n.data, ...patch } } : n)),
    );
    touched();
  }

  function onEdgeChange(id: string, patch: Partial<RoutingEdgeData>) {
    setEdges((current) =>
      current.map((e) =>
        e.id === id
          ? { ...e, data: { ...(e.data ?? { type: 'always', decision: null }), ...patch } }
          : e,
      ),
    );
    touched();
  }

  function deleteSelected() {
    if (selectedEdge) {
      setEdges((current) => current.filter((e) => e.id !== selectedEdge));
      setSelectedEdge(null);
    } else if (selectedNode && selectedNode !== STOP_NODE_ID) {
      setNodes((current) => current.filter((n) => n.id !== selectedNode));
      // Routings into or out of a deleted task would reference a task that is
      // gone, which the server rejects — so they go with it.
      setEdges((current) =>
        current.filter((e) => e.source !== selectedNode && e.target !== selectedNode),
      );
      setSelectedNode(null);
    }
    touched();
  }

  function relayout() {
    const { tasks, routings } = fromGraph(nodes, edges);
    const placed = autoLayout(tasks, routings);
    setNodes((current) =>
      current.map((n) =>
        n.type === 'task' && placed.has(n.id) ? { ...n, position: placed.get(n.id)! } : n,
      ),
    );
    touched();
  }

  function onSave() {
    const { tasks, routings, entryTaskKey } = fromGraph(nodes, edges);
    save.mutate({
      cabinetId,
      workflowId,
      entryTaskKey,
      name,
      description: description.trim() || undefined,
      // The trigger belongs to the revision, and this designer edits the graph:
      // pass it through as it was.
      trigger: initial.trigger as never,
      tasks,
      routings,
    });
  }

  const styledEdges = useMemo(
    () =>
      edges.map((e) => {
        const data = (e.data ?? { type: 'always', decision: null }) as RoutingEdgeData;
        const isStart = e.source === START_NODE_ID;
        const style = isStart
          ? { stroke: 'var(--accent)', label: () => 'start' }
          : EDGE_STYLE[data.type] ?? EDGE_STYLE.always;
        const bad = problemIds.has(e.id);
        return {
          ...e,
          label: style.label(data.decision),
          labelStyle: { fill: style.stroke, fontSize: 11 },
          labelBgStyle: { fill: 'var(--surface)' },
          labelBgPadding: [4, 2] as [number, number],
          animated: data.type === 'onDecision',
          style: {
            stroke: bad ? 'var(--danger)' : style.stroke,
            strokeWidth: bad ? 2.5 : 1.5,
            strokeDasharray: bad ? '5 3' : undefined,
          },
          markerEnd: { type: MarkerType.ArrowClosed, color: style.stroke },
        };
      }),
    [edges, problemIds],
  );

  const styledNodes = useMemo(
    () =>
      nodes.map((n) =>
        problemIds.has(n.id) ? { ...n, className: 'wf-node-problem' } : n,
      ),
    [nodes, problemIds],
  );

  const selected = nodes.find((n) => n.id === selectedNode) ?? null;
  const selectedEdgeObject = edges.find((e) => e.id === selectedEdge) ?? null;

  return (
    <div className="wf-designer">
      <div className="viewer-toolbar">
        <input
          value={name}
          disabled={readOnly}
          placeholder="Workflow name"
          onChange={(e) => {
            setName(e.target.value);
            touched();
          }}
          style={{ width: 220 }}
        />
        <input
          value={description}
          disabled={readOnly}
          placeholder="Description"
          onChange={(e) => {
            setDescription(e.target.value);
            touched();
          }}
          style={{ width: 240 }}
        />
        {initial.revision ? (
          <span className="pill">
            r{initial.revision}
            {initial.published ? ' · published' : ''}
          </span>
        ) : null}
        <span className="spacer" />
        <button onClick={relayout} disabled={readOnly}>
          Tidy up
        </button>
        <button
          className="primary"
          onClick={onSave}
          disabled={readOnly || save.isPending || problems.length > 0 || !name.trim()}
          title={problems.length > 0 ? 'Fix the problems listed below first' : undefined}
        >
          {save.isPending ? 'Saving…' : dirty ? 'Save revision' : 'Saved'}
        </button>
        {workflowId && initial.revision ? (
          <button
            onClick={() =>
              publish.mutate({ cabinetId, workflowId, revision: initial.revision! })
            }
            disabled={readOnly || dirty || initial.published || publish.isPending}
            title={dirty ? 'Save first' : 'Make this revision the one that runs'}
          >
            {initial.published ? 'Published' : 'Publish'}
          </button>
        ) : null}
      </div>

      <div className="viewer-toolbar viewer-toolbar-second">
        <span className="small muted">Add:</span>
        {WORKFLOW_TASK_TYPES.map((t) => (
          <button key={t} disabled={readOnly} onClick={() => addTask(t)}>
            {t}
          </button>
        ))}
      </div>

      {save.error ? <p className="error small">{save.error.message}</p> : null}
      {publish.error ? <p className="error small">{publish.error.message}</p> : null}

      {problems.length > 0 ? (
        <ul className="wf-problems">
          {problems.map((p, i) => (
            <li key={i} className="small">
              {p.message}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="wf-body">
        <div className="wf-canvas">
          <ReactFlow
            nodes={styledNodes}
            edges={styledEdges}
            onNodesChange={(changes) => {
              onNodesChange(changes);
              // A selection change is not an edit; only a move or a removal is.
              if (changes.some((c) => c.type === 'position' || c.type === 'remove')) {
                touched();
              }
            }}
            onEdgesChange={(changes) => {
              onEdgesChange(changes);
              if (changes.some((c) => c.type === 'remove')) touched();
            }}
            onConnect={onConnect}
            onNodeClick={(_, node) => {
              setSelectedNode(node.id);
              setSelectedEdge(null);
            }}
            onEdgeClick={(_, edge) => {
              setSelectedEdge(edge.id);
              setSelectedNode(null);
            }}
            onPaneClick={() => {
              setSelectedNode(null);
              setSelectedEdge(null);
            }}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            elementsSelectable
            fitView
            proOptions={{ hideAttribution: false }}
          >
            <Background />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>

        <Inspector
          node={selected}
          edge={selectedEdgeObject}
          roles={assignees.data?.roles ?? []}
          users={assignees.data?.users ?? []}
          onTaskChange={onTaskChange}
          onEdgeChange={onEdgeChange}
          onDelete={deleteSelected}
          readOnly={readOnly}
        />
      </div>
    </div>
  );
}
