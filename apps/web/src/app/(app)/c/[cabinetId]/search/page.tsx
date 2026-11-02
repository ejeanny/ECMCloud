'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  ArrowLeft,
  File as FileIcon,
  FileDown,
  MousePointerClick,
  Plus,
  Search as SearchIcon,
  SearchX,
  Trash2,
} from 'lucide-react';

import { DocumentPanel } from '@/components/document-panel';
import { PageHeader } from '@/components/page-header';
import { Pager } from '@/components/pager';
import { EmptyState, InlineError, TableSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatBytes, formatDate } from '@/lib/format';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

type Operator =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'isEmpty'
  | 'isNotEmpty';

interface Criterion {
  fieldId: string;
  operator: Operator;
  value: string;
}

const OPERATORS: Array<readonly [Operator, string]> = [
  ['contains', 'contains'],
  ['eq', 'equals'],
  ['neq', 'does not equal'],
  ['startsWith', 'starts with'],
  ['endsWith', 'ends with'],
  ['gt', 'greater than'],
  ['gte', 'at least'],
  ['lt', 'less than'],
  ['lte', 'at most'],
  ['isEmpty', 'is empty'],
  ['isNotEmpty', 'is not empty'],
];

const PAGE = 50;

export default function SearchPage() {
  const { cabinetId } = useParams<{ cabinetId: string }>();
  const columns = trpc.indexField.columns.useQuery({ cabinetId });

  const [text, setText] = useState('');
  const [fullText, setFullText] = useState(true);
  const [criteria, setCriteria] = useState<Criterion[]>([]);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<null | {
    text: string;
    fullText: boolean;
    criteria: Criterion[];
  }>(null);

  const args = submitted
    ? {
        cabinetIds: [cabinetId],
        text: submitted.text || undefined,
        fullText: submitted.fullText,
        fields: submitted.criteria
          .filter((c) => c.fieldId)
          .map((c) => ({
            fieldId: c.fieldId,
            operator: c.operator,
            value:
              c.operator === 'isEmpty' || c.operator === 'isNotEmpty'
                ? undefined
                : c.value,
          })),
        includeRecycleBin: false,
        skip: page * PAGE,
        take: PAGE,
      }
    : null;

  const results = trpc.search.documents.useQuery(args!, { enabled: args !== null });
  const total = trpc.search.count.useQuery(args!, { enabled: args !== null });
  const snippets = trpc.search.snippets.useQuery(
    {
      nodeIds: (results.data?.items ?? []).map((n) => n.id),
      text: submitted?.text ?? '',
    },
    {
      enabled:
        Boolean(submitted?.text) &&
        Boolean(submitted?.fullText) &&
        (results.data?.items.length ?? 0) > 0,
    },
  );

  const snippetById = new Map(
    (snippets.data ?? []).map((s) => [s.nodeId, s.snippet] as const),
  );

  const exportRows = trpc.search.exportRows.useQuery(args!, { enabled: false });

  async function downloadCsv() {
    const result = await exportRows.refetch();
    const rows = result.data?.rows ?? [];
    if (rows.length === 0) return;

    const headers = Object.keys(rows[0]!);
    const escape = (v: unknown) =>
      v === null || v === undefined ? '' : `"${String(v).replace(/"/g, '""')}"`;
    const csv = [
      headers.join(','),
      ...rows.map((r) => headers.map((h) => escape(r[h])).join(',')),
    ].join('\r\n');

    const url = URL.createObjectURL(
      new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `search-results-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const matches = total.data ?? 0;

  return (
    <>
      <PageHeader
        title="Search"
        description="Names, extracted document text, and any index field in this cabinet."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={`/c/${cabinetId}`}>
              <ArrowLeft />
              Back to cabinet
            </Link>
          </Button>
        }
      />

      <Card className="mb-4 py-5">
        <CardContent className="px-5">
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              setPage(0);
              setSubmitted({ text, fullText, criteria });
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="q">Text</Label>
              <div className="relative">
                <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                <Input
                  id="q"
                  className="pl-9"
                  value={text}
                  placeholder="Name, and extracted document text"
                  onChange={(e) => setText(e.target.value)}
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="fullText"
                checked={fullText}
                onCheckedChange={(checked) => setFullText(checked === true)}
              />
              <Label htmlFor="fullText" className="text-muted-foreground font-normal">
                Search extracted document text as well as names
              </Label>
            </div>

            {criteria.length > 0 ? <Separator /> : null}

            {criteria.map((c, i) => {
              const noValue = c.operator === 'isEmpty' || c.operator === 'isNotEmpty';
              return (
                <div
                  key={i}
                  className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
                >
                  <Select
                    value={c.fieldId}
                    onValueChange={(value) =>
                      setCriteria((list) =>
                        list.map((x, j) => (i === j ? { ...x, fieldId: value } : x)),
                      )
                    }
                  >
                    <SelectTrigger aria-label="Field">
                      <SelectValue placeholder="Select a field…" />
                    </SelectTrigger>
                    <SelectContent>
                      {(columns.data ?? []).map((f) => (
                        <SelectItem key={f.id} value={f.id}>
                          {f.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Select
                    value={c.operator}
                    onValueChange={(value) =>
                      setCriteria((list) =>
                        list.map((x, j) =>
                          i === j ? { ...x, operator: value as Operator } : x,
                        ),
                      )
                    }
                  >
                    <SelectTrigger aria-label="Operator">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {OPERATORS.map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Input
                    aria-label="Value"
                    value={c.value}
                    disabled={noValue}
                    placeholder={noValue ? '—' : 'Value'}
                    onChange={(e) =>
                      setCriteria((list) =>
                        list.map((x, j) => (i === j ? { ...x, value: e.target.value } : x)),
                      )
                    }
                  />

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove criterion"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setCriteria((list) => list.filter((_, j) => j !== i))}
                  >
                    <Trash2 />
                  </Button>
                </div>
              );
            })}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setCriteria((list) => [
                    ...list,
                    { fieldId: '', operator: 'contains', value: '' },
                  ])
                }
              >
                <Plus />
                Add field criterion
              </Button>
              <span className="flex-1" />
              <Button type="submit" size="sm">
                <SearchIcon />
                Search
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {results.error ? (
        <InlineError className="mb-3" message={results.error.message} />
      ) : null}

      {submitted ? (
        <>
          <div className="mb-3 flex items-center gap-2">
            <p className="text-muted-foreground text-xs">
              {matches} match{matches === 1 ? '' : 'es'}
            </p>
            <span className="flex-1" />
            <Button
              variant="outline"
              size="sm"
              onClick={() => void downloadCsv()}
              disabled={!matches || exportRows.isFetching}
            >
              <FileDown />
              Export CSV
            </Button>
          </div>

          <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_21rem]">
            <div className="min-w-0">
              <div className="bg-card overflow-hidden rounded-xl border">
                <Table className="table-fixed">
                  <TableHeader>
                    <TableRow className="hover:bg-muted/50">
                      <TableHead>Name</TableHead>
                      <TableHead className="w-20">Type</TableHead>
                      <TableHead className="w-24">Size</TableHead>
                      <TableHead className="w-44">Modified</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {results.isLoading ? (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={4} className="p-0">
                          <TableSkeleton rows={6} columns={4} />
                        </TableCell>
                      </TableRow>
                    ) : null}

                    {!results.isLoading && (results.data?.items.length ?? 0) === 0 ? (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={4} className="p-0">
                          <EmptyState
                            className="border-0"
                            icon={<SearchX />}
                            title="No documents match"
                            description="Loosen a criterion, or turn off the full-text option to search names only."
                          />
                        </TableCell>
                      </TableRow>
                    ) : null}

                    {(results.data?.items ?? []).map((node) => {
                      const snippet = snippetById.get(node.id);
                      return (
                        <TableRow
                          key={node.id}
                          aria-selected={selected === node.id}
                          className={cn('cursor-pointer')}
                          onClick={() => setSelected(node.id)}
                        >
                          <TableCell className="align-top" title={node.name}>
                            <div className="flex min-w-0 items-start gap-2">
                              <FileIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                              <div className="min-w-0">
                                <span className="break-words">{node.name}</span>
                                {snippet ? (
                                  <p className="text-muted-foreground mt-0.5 text-xs">
                                    {snippet}
                                  </p>
                                ) : null}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground align-top text-xs">
                            {node.ext?.toUpperCase() ?? '—'}
                          </TableCell>
                          <TableCell className="text-muted-foreground align-top text-xs tabular-nums">
                            {formatBytes(node.byteLength)}
                          </TableCell>
                          <TableCell className="text-muted-foreground align-top text-xs">
                            {formatDate(node.modified)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              <Pager
                page={page}
                pageCount={Math.max(1, Math.ceil(matches / PAGE))}
                onPage={setPage}
                summary={
                  matches
                    ? `${page * PAGE + 1}–${Math.min((page + 1) * PAGE, matches)} of ${matches}`
                    : undefined
                }
              />
            </div>

            {selected ? (
              <DocumentPanel nodeId={selected} onChanged={() => results.refetch()} />
            ) : (
              <aside className="bg-card hidden rounded-xl border p-5 xl:block">
                <EmptyState
                  className="border-0 px-0 py-2"
                  icon={<MousePointerClick />}
                  title="Nothing selected"
                  description="Select a result to see its index values, versions and notes."
                />
              </aside>
            )}
          </div>
        </>
      ) : null}
    </>
  );
}
