'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { WorkflowDesigner } from '@/components/workflow/designer';
import type { TriggerClause } from '@/components/workflow/trigger-editor';
import type { DesignRouting, DesignTask } from '@/lib/workflow/graph';
import { trpc } from '@/lib/trpc';

/**
 * The visual designer, replacing the Rappid/JointJS canvas Dokmee licensed.
 *
 * `new` opens an empty graph; a workflow id opens its latest revision, or the
 * one named by `?revision=`. Saving always creates a revision, so an earlier
 * one can be opened and saved forward rather than edited in place.
 */
export default function WorkflowDesignerPage() {
  const { cabinetId, workflowId } = useParams<{ cabinetId: string; workflowId: string }>();
  const router = useRouter();
  const params = useSearchParams();
  const isNew = workflowId === 'new';
  const revisionParam = params.get('revision');

  const existing = trpc.workflow.byId.useQuery(
    {
      workflowId,
      ...(revisionParam ? { revision: Number.parseInt(revisionParam, 10) } : {}),
    },
    { enabled: !isNew },
  );
  const list = trpc.workflow.list.useQuery({ cabinetId });

  if (!isNew && existing.isLoading) return <p className="muted">Loading…</p>;
  if (!isNew && existing.error) {
    return (
      <p className="error" role="alert">
        {existing.error.message}
      </p>
    );
  }

  const data = existing.data;
  const summary = (list.data ?? []).find((w) => w.id === workflowId);

  const initial = isNew
    ? {
        name: '',
        description: null,
        revision: null,
        published: false,
        tasks: [] as DesignTask[],
        routings: [] as DesignRouting[],
        entryTaskKey: null,
        trigger: {
          onNewDocument: false,
          onIndexChanged: false,
          combine: 'and' as const,
          clauses: [] as TriggerClause[],
        },
      }
    : {
        name: data!.workflow.name,
        description: data!.workflow.description,
        revision: data!.revision,
        published: data!.published,
        tasks: data!.tasks as DesignTask[],
        routings: data!.routings as DesignRouting[],
        entryTaskKey: data!.entryTaskKey,
        trigger: {
          onNewDocument: data!.trigger.onNewDocument,
          onIndexChanged: data!.trigger.onIndexChanged,
          combine: data!.trigger.combine as 'and' | 'or',
          clauses: (data!.trigger.clauses ?? []) as TriggerClause[],
        },
      };

  // A published revision is what running instances follow, so it is read-only
  // here; saving forward from it produces a new revision to publish instead.
  const readOnly = !isNew && data!.published;

  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <Link className="pill" href={`/c/${cabinetId}/workflows`}>
          ← Workflows
        </Link>
        {summary && summary.revisions.length > 1 ? (
          <span className="row small">
            <span className="muted">Revision:</span>
            {summary.revisions.map((r) => (
              <Link
                key={r.revision}
                className="pill"
                href={`/c/${cabinetId}/workflows/${workflowId}?revision=${r.revision}`}
                style={
                  data?.revision === r.revision
                    ? { borderColor: 'var(--accent)', color: 'var(--accent)' }
                    : undefined
                }
              >
                r{r.revision}
                {r.published ? ' ✓' : ''}
              </Link>
            ))}
          </span>
        ) : null}
      </div>

      {readOnly ? (
        <p className="small muted">
          This revision is published and is what running instances follow, so it
          is shown read-only. Open the latest revision to make changes.
        </p>
      ) : null}

      <WorkflowDesigner
        cabinetId={cabinetId}
        workflowId={isNew ? undefined : workflowId}
        initial={initial}
        readOnly={readOnly}
        onSaved={({ workflowId: saved, revision }) => {
          router.replace(`/c/${cabinetId}/workflows/${saved}?revision=${revision}`);
        }}
      />
    </>
  );
}
