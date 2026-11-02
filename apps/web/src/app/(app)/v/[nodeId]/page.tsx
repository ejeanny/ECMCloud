'use client';

import { useParams, useRouter } from 'next/navigation';
import { DocumentViewer } from '@/components/viewer/document-viewer';
import { trpc } from '@/lib/trpc';

/**
 * The viewer gets a route of its own rather than a panel inside the explorer:
 * it wants the whole width, and a document worth annotating is a document worth
 * being able to send someone a link to.
 */
export default function ViewerPage() {
  const { nodeId } = useParams<{ nodeId: string }>();
  const router = useRouter();
  const detail = trpc.node.byId.useQuery({ nodeId });

  if (detail.isLoading) return <p className="muted">Loading…</p>;
  if (detail.error) {
    return (
      <p className="error" role="alert">
        {detail.error.message}
      </p>
    );
  }
  if (!detail.data) return null;

  const { node } = detail.data;
  if (node.kind !== 'document') {
    return <p className="muted">A folder has nothing to display.</p>;
  }

  return (
    <div style={{ height: 'calc(100vh - 120px)' }}>
      <DocumentViewer
        nodeId={nodeId}
        name={node.name}
        onClose={() => router.push(`/c/${node.cabinetId}`)}
      />
    </div>
  );
}
