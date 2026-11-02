'use client';

import { useState } from 'react';
import { formatDate } from '@/lib/format';
import { trpc } from '@/lib/trpc';

const ACTIONS = [
  'login',
  'logout',
  'loginFailed',
  'view',
  'download',
  'print',
  'create',
  'update',
  'delete',
  'restore',
  'purge',
  'move',
  'copy',
  'checkOut',
  'checkIn',
  'revertVersion',
  'indexUpdate',
  'share',
  'email',
  'export',
  'permissionChange',
] as const;

type Action = (typeof ACTIONS)[number];

const PAGE = 100;

export default function AuditPage() {
  const [action, setAction] = useState<Action | ''>('');
  const [cabinetId, setCabinetId] = useState('');
  const [page, setPage] = useState(0);

  const cabinets = trpc.cabinet.list.useQuery();
  const args = {
    skip: page * PAGE,
    take: PAGE,
    ...(action ? { actions: [action] } : {}),
    ...(cabinetId ? { cabinetId } : {}),
  };
  const log = trpc.audit.query.useQuery(args);
  const exportRows = trpc.audit.exportRows.useQuery({ ...args, take: 10_000 }, { enabled: false });

  async function downloadCsv() {
    const result = await exportRows.refetch();
    const rows = result.data?.rows ?? [];
    if (rows.length === 0) return;

    const headers = ['at', 'action', 'userName', 'cabinetId', 'nodeName', 'ipAddress', 'detail'];
    const escape = (v: unknown) =>
      v === null || v === undefined
        ? ''
        : `"${(typeof v === 'object' ? JSON.stringify(v) : String(v)).replace(/"/g, '""')}"`;
    const csv = [
      headers.join(','),
      ...rows.map((r) => headers.map((h) => escape((r as Record<string, unknown>)[h])).join(',')),
    ].join('\r\n');

    const url = URL.createObjectURL(
      new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <h2>Audit log</h2>

      <div className="row wrap" style={{ marginBottom: 12 }}>
        <div className="field" style={{ marginBottom: 0, width: 200 }}>
          <label htmlFor="action">Action</label>
          <select
            id="action"
            value={action}
            onChange={(e) => {
              setAction(e.target.value as Action | '');
              setPage(0);
            }}
          >
            <option value="">All actions</option>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>

        <div className="field" style={{ marginBottom: 0, width: 240 }}>
          <label htmlFor="cabinet">Cabinet</label>
          <select
            id="cabinet"
            value={cabinetId}
            onChange={(e) => {
              setCabinetId(e.target.value);
              setPage(0);
            }}
          >
            <option value="">All cabinets</option>
            {(cabinets.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <span className="spacer" />
        <span className="small muted">{log.data?.total ?? 0} record(s)</span>
        <button onClick={() => void downloadCsv()} disabled={!log.data?.total}>
          Export CSV
        </button>
      </div>

      {log.error ? <p className="error">{log.error.message}</p> : null}

      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th style={{ width: 170 }}>When</th>
              <th style={{ width: 130 }}>Action</th>
              <th style={{ width: 140 }}>User</th>
              <th>Document</th>
              <th style={{ width: 120 }}>IP</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {log.isLoading ? (
              <tr>
                <td colSpan={6} className="muted">
                  Loading…
                </td>
              </tr>
            ) : null}
            {(log.data?.items ?? []).map((r) => (
              <tr key={r.id}>
                <td className="small muted">{formatDate(r.at)}</td>
                <td className="small">{r.action}</td>
                <td className="small">{r.userName}</td>
                <td className="small muted" title={r.nodeName ?? undefined}>
                  {r.nodeName ?? '—'}
                </td>
                <td className="small muted">{r.ipAddress ?? '—'}</td>
                <td className="small muted mono">
                  {r.detail ? JSON.stringify(r.detail) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(log.data?.total ?? 0) > PAGE ? (
        <div className="row" style={{ marginTop: 10 }}>
          <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Previous
          </button>
          <span className="small muted">Page {page + 1}</span>
          <button
            disabled={(page + 1) * PAGE >= (log.data?.total ?? 0)}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      ) : null}
    </>
  );
}
