'use client';

import { formatBytes, formatDate } from '@/lib/format';
import { trpc } from '@/lib/trpc';

export default function FavoritesPage() {
  const utils = trpc.useUtils();
  const favorites = trpc.workspace.favorites.useQuery({ skip: 0, take: 200 });
  const remove = trpc.workspace.removeFavorites.useMutation({
    onSuccess: () => utils.workspace.favorites.invalidate(),
  });

  if (favorites.isLoading) return <p className="muted">Loading…</p>;
  if (favorites.error) return <p className="error">{favorites.error.message}</p>;

  const items = favorites.data?.items ?? [];
  if (items.length === 0) return <><h2>Favourites</h2><p className="muted">No favourites yet.</p></>;

  return (
    <>
      <h2>Favourites</h2>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th style={{ width: 100 }}>Size</th>
            <th style={{ width: 170 }}>Added</th>
            <th style={{ width: 150 }} />
          </tr>
        </thead>
        <tbody>
          {items.map(({ node, addedAt }) => (
            <tr key={node.id}>
              <td title={node.name}>
                <a href={`/file/${node.id}`} target="_blank" rel="noreferrer">
                  📄 {node.name}
                </a>
              </td>
              <td className="small muted">{formatBytes(node.byteLength)}</td>
              <td className="small muted">{formatDate(addedAt)}</td>
              <td>
                <div className="row small">
                  <a className="pill" href={`/file/${node.id}/download`}>
                    Download
                  </a>
                  <button
                    className="danger small"
                    onClick={() => remove.mutate({ nodeIds: [node.id] })}
                  >
                    Remove
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
