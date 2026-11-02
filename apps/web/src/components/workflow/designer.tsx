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
import { Check, LayoutTemplate, Loader2, Plus, Rocket, Save, TriangleAlert } from 'lucide-react';

import { WORKFLOW_TASK_TYPES, type RoutingType, type WorkflowTaskType } from '@ecm/domain';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { InlineError } from '@/components/states';
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
import { TriggerEditor, type TriggerState } from './trigger-editor';

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
    trigger: TriggerState;
  };
  readOnly: boolean;
  onSaved: (result: { workflowId: string; revision: number }) => void;
}

/** How an edge is drawn, by the condition it carries. */
const EDGE_STYLE: Record<RoutingType, { stroke: string; label: (d: string | null) => string }> = {
  always: { stroke: 'var(--muted-foreground)', label: () => '' },
  onApprove: { stroke: 'var(--success)', label: () => 'approve' },
  onReject: { stroke: 'var(--destructive)', label: () => 'reject' },
  onDecision: { stroke: 'var(--primary)', label: (d) => d || '(no choice)' },
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
  const [trigger, setTrigger] = useState<TriggerState>(initial.trigger);
  const [panel, setPanel] = useState<'selection' | 'trigger'>('selection');
  const [dirty, setDirty] = useState(false);

  const assignees = trpc.workflow.assignees.useQuery({ cabinetId });
  const fields = trpc.indexField.columns.useQuery({ cabinetId });
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
    setTrigger(initial.trigger);
    setDirty(false);
  }, [graph, initial.trigger, setNodes, setEdges]);

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
    setPanel('selection');
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
      trigger: trigger as never,
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
          ? { stroke: 'var(--primary)', label: () => 'start' }
          : EDGE_STYLE[data.type] ?? EDGE_STYLE.always;
        const bad = problemIds.has(e.id);
        return {
          ...e,
          label: style.label(data.decision),
          labelStyle: { fill: style.stroke, fontSize: 11 },
          labelBgStyle: { fill: 'var(--card)' },
          labelBgPadding: [4, 2] as [number, number],
          animated: data.type === 'onDecision',
          style: {
            stroke: bad ? 'var(--destructive)' : style.stroke,
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
        problemIds.has(n.id)
          ? {
              ...n,
              // React Flow puts the class on its own wrapper, so the ring has
              // to reach the card this component renders inside it.
              className:
                '[&>div]:border-destructive [&>div]:ring-2 [&>div]:ring-destructive/30',
            }
          : n,
      ),
    [nodes, problemIds],
  );

  const selected = nodes.find((n) => n.id === selectedNode) ?? null;
  const selectedEdgeObject = edges.find((e) => e.id === selectedEdge) ?? null;

  /** What the workflow starts on, in one line, or empty when nothing does. */
  const triggerSummary = (() => {
    const on: string[] = [];
    if (trigger.onNewDocument) on.push('a document is added');
    if (trigger.onIndexChanged) on.push('index values change');
    if (on.length === 0) return '';
    const when = on.join(' or ');
    return trigger.clauses.length === 0
      ? `starts when ${when}`
      : `starts when ${when}, if ${trigger.clauses.length} condition${
          trigger.clauses.length === 1 ? '' : 's'
        } hold${trigger.clauses.length === 1 ? 's' : ''}`;
  })();

  return (
    <div className="flex h-[calc(100dvh-13rem)] min-h-[32rem] flex-col gap-2">
      <div className="bg-card flex flex-wrap items-center gap-2 rounded-xl border p-2">
        <Input
          className="h-8 w-52"
          value={name}
          disabled={readOnly}
          placeholder="Workflow name"
          aria-label="Workflow name"
          onChange={(e) => {
            setName(e.target.value);
            touched();
          }}
        />
        <Input
          className="h-8 w-60"
          value={description}
          disabled={readOnly}
          placeholder="Description"
          aria-label="Description"
          onChange={(e) => {
            setDescription(e.target.value);
            touched();
          }}
        />

        {initial.revision ? (
          <Badge variant={initial.published ? 'success' : 'secondary'} className="font-mono">
            r{initial.revision}
            {initial.published ? ' · published' : ''}
          </Badge>
        ) : null}

        <span className="text-muted-foreground hidden text-xs lg:block">
          {triggerSummary || 'started by hand only'}
        </span>

        <span className="flex-1" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="sm" onClick={relayout} disabled={readOnly}>
              <LayoutTemplate />
              Tidy up
            </Button>
          </TooltipTrigger>
          <TooltipContent>Lay the graph out again, left to right</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              onClick={onSave}
              disabled={readOnly || save.isPending || problems.length > 0 || !name.trim()}
            >
              {save.isPending ? <Loader2 className="animate-spin" /> : <Save />}
              {save.isPending ? 'Saving…' : dirty ? 'Save revision' : 'Saved'}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {problems.length > 0
              ? 'Fix the problems listed below first'
              : 'Saving always creates a new revision'}
          </TooltipContent>
        </Tooltip>

        {workflowId && initial.revision ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  publish.mutate({ cabinetId, workflowId, revision: initial.revision! })
                }
                disabled={readOnly || dirty || initial.published || publish.isPending}
              >
                {initial.published ? <Check /> : <Rocket />}
                {initial.published ? 'Published' : 'Publish'}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {dirty ? 'Save first' : 'Make this revision the one that runs'}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      <div className="bg-muted/50 flex flex-wrap items-center gap-1.5 rounded-xl border p-2">
        <span className="text-muted-foreground mr-1 inline-flex items-center gap-1 text-xs font-medium">
          <Plus className="size-3.5" />
          Add task
        </span>
        <Separator orientation="vertical" className="mr-1 h-5" />
        {WORKFLOW_TASK_TYPES.map((t) => (
          <Button
            key={t}
            variant="outline"
            size="xs"
            disabled={readOnly}
            onClick={() => addTask(t)}
          >
            {t}
          </Button>
        ))}
      </div>

      {save.error ? <InlineError message={save.error.message} /> : null}
      {publish.error ? <InlineError message={publish.error.message} /> : null}

      {problems.length > 0 ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>
            {problems.length} problem{problems.length === 1 ? '' : 's'} to fix before
            saving
          </AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-0.5 pl-4">
              {problems.map((p, i) => (
                <li key={i}>{p.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex min-h-0 flex-1 gap-2">
        <div className="bg-muted/40 min-w-0 flex-1 overflow-hidden rounded-xl border">
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
              setPanel('selection');
            }}
            onEdgeClick={(_, edge) => {
              setSelectedEdge(edge.id);
              setSelectedNode(null);
              setPanel('selection');
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
            <Background gap={16} size={1} />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>

        <div className="hidden w-80 shrink-0 flex-col gap-2 lg:flex">
          <Tabs
            value={panel}
            onValueChange={(value) => setPanel(value as 'selection' | 'trigger')}
          >
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="selection">Selection</TabsTrigger>
              <TabsTrigger value="trigger">
                Trigger
                {triggerSummary ? (
                  <span className="bg-primary size-1.5 rounded-full" aria-hidden />
                ) : null}
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {panel === 'trigger' ? (
            <TriggerEditor
              value={trigger}
              fields={fields.data ?? []}
              readOnly={readOnly}
              onChange={(next) => {
                setTrigger(next);
                touched();
              }}
            />
          ) : (
            <Inspector
              node={selected}
              edge={selectedEdgeObject}
              roles={assignees.data?.roles ?? []}
              users={assignees.data?.users ?? []}
              fields={fields.data ?? []}
              onTaskChange={onTaskChange}
              onEdgeChange={onEdgeChange}
              onDelete={deleteSelected}
              readOnly={readOnly}
            />
          )}
        </div>
      </div>
    </div>
  );
}
