'use client';

import { useParams } from 'next/navigation';
import { formatDate } from '@/lib/format';
import { trpc } from '@/lib/trpc';

export default function WorkflowsPage() {
  const { cabinetId } = useParams<{ cabinetId: string }>();
  const utils = trpc.useUtils();
  const workflows = trpc.workflow.list.useQuery({ cabinetId });

  const publish = trpc.workflow.publish.useMutation({
    onSuccess: () => utils.workflow.list.invalidate({ cabinetId }),
  });

  if (workflows.isLoading) return <p className="muted">Loading workflows…</p>;
  if (workflows.error) return <p className="error">{workflows.error.message}</p>;

  const items = workflows.data ?? [];

  return (
    <>
      <h2>Workflows</h2>
      <p className="muted small">
        A workflow has design revisions; one is published and is what triggers
        and manual starts run. Revisions are immutable once published.
      </p>

      {items.length === 0 ? (
        <p className="muted">No workflow is defined in this cabinet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th style={{ width: 110 }}>Published</th>
              <th style={{ width: 110 }}>Revisions</th>
              <th style={{ width: 110 }}>Instances</th>
              <th style={{ width: 90 }}>State</th>
              <th style={{ width: 200 }} />
            </tr>
          </thead>
          <tbody>
            {items.map((w) => (
              <tr key={w.id}>
                <td>
                  {w.name}
                  {w.description ? (
                    <div className="small muted">{w.description}</div>
                  ) : null}
                </td>
                <td className="small muted">
                  {w.publishedRevision ? `r${w.publishedRevision}` : '—'}
                </td>
                <td className="small muted">{w.revisions.length}</td>
                <td className="small muted">{w.instanceCount}</td>
                <td className="small">
                  {w.inError ? (
                    <span className="pill">error</span>
                  ) : w.isLocked ? (
                    <span className="pill">locked</span>
                  ) : (
                    <span className="pill">ok</span>
                  )}
                </td>
                <td>
                  <div className="row small">
                    <select
                      defaultValue=""
                      onChange={(e) => {
                        const revision = Number(e.target.value);
                        if (revision) {
                          publish.mutate({ cabinetId, workflowId: w.id, revision });
                          e.currentTarget.value = '';
                        }
                      }}
                    >
                      <option value="">Publish revision…</option>
                      {w.revisions
                        .filter((r) => !r.published)
                        .map((r) => (
                          <option key={r.id} value={r.revision}>
                            r{r.revision} — {formatDate(r.created)}
                          </option>
                        ))}
                    </select>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {publish.error ? (
        <p className="error" style={{ marginTop: 10 }}>
          {publish.error.message}
        </p>
      ) : null}

      <p className="small muted" style={{ marginTop: 14 }}>
        The visual designer Dokmee built on Rappid/JointJS is not part of this
        rebuild; workflows are saved through <code>workflow.save</code>, which
        takes the task and routing graph directly.
      </p>
    </>
  );
}
