'use client';

import { useParams, useRouter } from 'next/navigation';
import { Folder } from 'lucide-react';

import { DocumentViewer } from '@/components/viewer/document-viewer';
import { EmptyState, ErrorState } from '@/components/states';
import { Skeleton } from '@/components/ui/skeleton';
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

  if (detail.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-12 w-full rounded-xl" />
        <Skeleton className="h-10 w-full rounded-xl" />
        <Skeleton className="h-[26rem] w-full rounded-xl" />
      </div>
    );
  }

  if (detail.error) return <ErrorState message={detail.error.message} />;
  if (!detail.data) return null;

  const { node } = detail.data;
  if (node.kind !== 'document') {
    return (
      <EmptyState
        icon={<Folder />}
        title="A folder has nothing to display"
        description="Open a document to view and annotate it."
      />
    );
  }

  return (
    <div className="h-[calc(100dvh-7rem)]">
      <DocumentViewer
        nodeId={nodeId}
        name={node.name}
        onClose={() => router.push(`/c/${node.cabinetId}`)}
      />
    </div>
  );
}
