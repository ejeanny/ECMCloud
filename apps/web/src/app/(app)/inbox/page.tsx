'use client';

import { useState } from 'react';
import { formatDate } from '@/lib/format';
import { trpc } from '@/lib/trpc';

export default function InboxPage() {
  const utils = trpc.useUtils();
  const todos = trpc.workflow.myTodos.useQuery({ skip: 0, take: 100 });
  const [comment, setComment] = useState<Record<string, string>>({});

  const complete = trpc.workflow.completeTodo.useMutation({
    onSuccess() {
      void utils.workflow.myTodos.invalidate();
    },
  });

  if (todos.isLoading) return <p className="muted">Loading tasks…</p>;
  if (todos.error) return <p className="error">{todos.error.message}</p>;

  const items = todos.data?.items ?? [];

  return (
    <>
      <h2>My tasks</h2>

      {items.length === 0 ? (
        <p className="muted">Nothing is waiting on you.</p>
      ) : null}

      {complete.error ? <p className="error">{complete.error.message}</p> : null}

      {items.map((todo) => (
        <article className="card" key={todo.id} style={{ marginBottom: 12 }}>
          <div className="row wrap">
            <strong>{todo.task.name}</strong>
            <span className="pill">{todo.task.type}</span>
            <span className="spacer" />
            <span className="small muted">
              {todo.instance.workflow.name} · started {formatDate(todo.instance.started)}
            </span>
          </div>

          <p style={{ margin: '6px 0' }}>
            <a href={`/file/${todo.instance.node.id}`} target="_blank" rel="noreferrer">
              📄 {todo.instance.node.name}
            </a>
          </p>

          <div className="field">
            <label htmlFor={`c-${todo.id}`}>Comment (optional)</label>
            <input
              id={`c-${todo.id}`}
              value={comment[todo.id] ?? ''}
              onChange={(e) =>
                setComment((c) => ({ ...c, [todo.id]: e.target.value }))
              }
            />
          </div>

          <div className="row">
            <button
              className="primary"
              disabled={complete.isPending}
              onClick={() =>
                complete.mutate({
                  todoId: todo.id,
                  decision: 'approve',
                  comment: comment[todo.id] || undefined,
                })
              }
            >
              Approve
            </button>
            <button
              className="danger"
              disabled={complete.isPending}
              onClick={() =>
                complete.mutate({
                  todoId: todo.id,
                  decision: 'reject',
                  comment: comment[todo.id] || undefined,
                })
              }
            >
              Reject
            </button>
          </div>
        </article>
      ))}
    </>
  );
}
