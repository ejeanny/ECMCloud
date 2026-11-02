'use client';

import { useState } from 'react';
import { FileDown, ScrollText } from 'lucide-react';

import { PageHeader } from '@/components/page-header';
import { Pager } from '@/components/pager';
import { EmptyState, InlineError, TableSkeleton } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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

/** Actions worth colouring, so a scan down the column finds them. */
const TONE: Partial<Record<Action, 'destructive' | 'warning' | 'success'>> = {
  loginFailed: 'destructive',
  delete: 'destructive',
  purge: 'destructive',
  permissionChange: 'warning',
  export: 'warning',
  login: 'success',
};

const ALL = '__all__';
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
  const exportRows = trpc.audit.exportRows.useQuery(
    { ...args, take: 10_000 },
    { enabled: false },
  );

  async function downloadCsv() {
    const result = await exportRows.refetch();
    const rows = result.data?.rows ?? [];
    if (rows.length === 0) return;

    const headers = [
      'at',
      'action',
      'userName',
      'cabinetId',
      'nodeName',
      'ipAddress',
      'detail',
    ];
    const escape = (v: unknown) =>
      v === null || v === undefined
        ? ''
        : `"${(typeof v === 'object' ? JSON.stringify(v) : String(v)).replace(/"/g, '""')}"`;
    const csv = [
      headers.join(','),
      ...rows.map((r) =>
        headers.map((h) => escape((r as Record<string, unknown>)[h])).join(','),
      ),
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

  const totalRecords = log.data?.total ?? 0;
  const items = log.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every recorded action, who took it and where from."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void downloadCsv()}
            disabled={!totalRecords || exportRows.isFetching}
          >
            <FileDown />
            Export CSV
          </Button>
        }
      />

      <div className="bg-card mb-3 flex flex-wrap items-end gap-3 rounded-xl border p-3">
        <div className="w-48 space-y-2">
          <Label htmlFor="action" className="text-muted-foreground text-xs">
            Action
          </Label>
          <Select
            value={action || ALL}
            onValueChange={(value) => {
              setAction(value === ALL ? '' : (value as Action));
              setPage(0);
            }}
          >
            <SelectTrigger id="action" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All actions</SelectItem>
              {ACTIONS.map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="w-60 space-y-2">
          <Label htmlFor="cabinet" className="text-muted-foreground text-xs">
            Cabinet
          </Label>
          <Select
            value={cabinetId || ALL}
            onValueChange={(value) => {
              setCabinetId(value === ALL ? '' : value);
              setPage(0);
            }}
          >
            <SelectTrigger id="cabinet" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All cabinets</SelectItem>
              {(cabinets.data ?? []).map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <span className="flex-1" />

        <p className="text-muted-foreground pb-2 text-xs tabular-nums">
          {totalRecords} record{totalRecords === 1 ? '' : 's'}
        </p>
      </div>

      {log.error ? <InlineError className="mb-3" message={log.error.message} /> : null}

      <div className="bg-card overflow-hidden rounded-xl border">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow className="hover:bg-muted/50">
              <TableHead className="w-44">When</TableHead>
              <TableHead className="w-36">Action</TableHead>
              <TableHead className="w-36">User</TableHead>
              <TableHead>Document</TableHead>
              <TableHead className="w-32">IP</TableHead>
              <TableHead className="w-80">Detail</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {log.isLoading ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="p-0">
                  <TableSkeleton rows={8} columns={6} />
                </TableCell>
              </TableRow>
            ) : null}

            {!log.isLoading && items.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="p-0">
                  <EmptyState
                    className="border-0"
                    icon={<ScrollText />}
                    title="No records match"
                    description="Widen the filters above to see more of the log."
                  />
                </TableCell>
              </TableRow>
            ) : null}

            {items.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                  {formatDate(r.at)}
                </TableCell>
                <TableCell>
                  <Badge variant={TONE[r.action as Action] ?? 'secondary'}>
                    {r.action}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs">
                  <span className="block truncate">{r.userName}</span>
                </TableCell>
                <TableCell
                  className="text-muted-foreground text-xs"
                  title={r.nodeName ?? undefined}
                >
                  <span className="block truncate">{r.nodeName ?? '—'}</span>
                </TableCell>
                <TableCell className="text-muted-foreground font-mono text-xs">
                  {r.ipAddress ?? '—'}
                </TableCell>
                <TableCell className="text-muted-foreground font-mono text-xs">
                  <span className="block truncate" title={r.detail ? JSON.stringify(r.detail) : undefined}>
                    {r.detail ? JSON.stringify(r.detail) : '—'}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Pager
        page={page}
        pageCount={Math.max(1, Math.ceil(totalRecords / PAGE))}
        onPage={setPage}
        summary={
          totalRecords
            ? `${page * PAGE + 1}–${Math.min((page + 1) * PAGE, totalRecords)} of ${totalRecords}`
            : undefined
        }
      />
    </>
  );
}
