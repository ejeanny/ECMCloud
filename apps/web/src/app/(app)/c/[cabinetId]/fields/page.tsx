'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ArrowLeft, Columns3, Lock, Plus, Trash2 } from 'lucide-react';

import { PageHeader } from '@/components/page-header';
import { EmptyState, InlineError } from '@/components/states';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { trpc } from '@/lib/trpc';

const TYPES = [
  'text',
  'number',
  'decimal',
  'date',
  'datetime',
  'boolean',
  'selectList',
  'multiSelect',
  'autoNumber',
] as const;

type FieldType = (typeof TYPES)[number];

export default function FieldsPage() {
  const { cabinetId } = useParams<{ cabinetId: string }>();
  const utils = trpc.useUtils();
  const fields = trpc.indexField.list.useQuery({ cabinetId });

  const [label, setLabel] = useState('');
  const [type, setType] = useState<FieldType>('text');
  const [isRequired, setIsRequired] = useState(false);
  const [folderLevel, setFolderLevel] = useState(0);
  const [selectValues, setSelectValues] = useState('');
  const [pendingDelete, setPendingDelete] = useState<{ id: string; label: string } | null>(
    null,
  );

  function refresh() {
    void utils.indexField.list.invalidate({ cabinetId });
    void utils.indexField.columns.invalidate({ cabinetId });
  }

  const create = trpc.indexField.create.useMutation({
    onSuccess() {
      setLabel('');
      setSelectValues('');
      refresh();
    },
  });
  const remove = trpc.indexField.delete.useMutation({
    onSuccess() {
      setPendingDelete(null);
      refresh();
    },
  });

  const needsValues = type === 'selectList' || type === 'multiSelect';
  const items = fields.data ?? [];

  return (
    <>
      <PageHeader
        title="Index fields"
        description="A cabinet’s index fields define the metadata every document in it carries. A field with a folder level above zero also organises the tree."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={`/c/${cabinetId}`}>
              <ArrowLeft />
              Back to cabinet
            </Link>
          </Button>
        }
      />

      <Card className="mb-5 max-w-2xl py-5">
        <CardContent className="px-5">
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate({
                cabinetId,
                label: label.trim(),
                type,
                isRequired,
                isRestricted: false,
                isLocked: false,
                folderLevel,
                sort: items.length + 1,
                selectValues: needsValues
                  ? selectValues
                      .split('\n')
                      .map((v) => v.trim())
                      .filter(Boolean)
                  : undefined,
              });
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="label">Label</Label>
              <Input
                id="label"
                required
                value={label}
                placeholder="e.g. Invoice number"
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="type">Type</Label>
                <Select
                  value={type}
                  onValueChange={(value) => setType(value as FieldType)}
                >
                  <SelectTrigger id="type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="folderLevel">Folder level</Label>
                <Input
                  id="folderLevel"
                  type="number"
                  min={0}
                  max={16}
                  value={folderLevel}
                  onChange={(e) => setFolderLevel(Number(e.target.value))}
                />
                <p className="text-muted-foreground text-xs">
                  0 means the field is not a folder level.
                </p>
              </div>
            </div>

            {needsValues ? (
              <div className="space-y-2">
                <Label htmlFor="values">Values, one per line</Label>
                <Textarea
                  id="values"
                  rows={4}
                  required
                  value={selectValues}
                  onChange={(e) => setSelectValues(e.target.value)}
                />
              </div>
            ) : null}

            <div className="flex items-center gap-2">
              <Checkbox
                id="required"
                checked={isRequired}
                onCheckedChange={(checked) => setIsRequired(checked === true)}
              />
              <Label htmlFor="required" className="font-normal">
                Required
              </Label>
            </div>

            {create.error ? <InlineError message={create.error.message} /> : null}

            <Button type="submit" disabled={create.isPending || !label.trim()}>
              <Plus />
              Add field
            </Button>
          </form>
        </CardContent>
      </Card>

      {remove.error ? (
        <InlineError className="mb-3" message={remove.error.message} />
      ) : null}

      {!fields.isLoading && items.length === 0 ? (
        <EmptyState
          icon={<Columns3 />}
          title="No index fields yet"
          description="Add one above and every document in this cabinet gains that piece of metadata."
        />
      ) : (
        <div className="bg-card overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-muted/50">
                <TableHead>Label</TableHead>
                <TableHead className="w-28">Type</TableHead>
                <TableHead className="w-24">Required</TableHead>
                <TableHead className="w-28">Folder level</TableHead>
                <TableHead className="w-32">Values</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((f) => (
                <TableRow key={f.id}>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{f.label}</span>
                      {f.isDefault ? <Badge variant="secondary">default</Badge> : null}
                      {f.isLocked ? (
                        <Badge variant="outline">
                          <Lock />
                          locked
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">
                    {f.type}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {f.isRequired ? 'Yes' : 'No'}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs tabular-nums">
                    {f.folderLevel || '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {f.selectValues.length > 0
                      ? `${f.selectValues.length} value${f.selectValues.length === 1 ? '' : 's'}`
                      : '—'}
                  </TableCell>
                  <TableCell>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Delete ${f.label}`}
                          className="text-destructive hover:text-destructive"
                          disabled={f.isDefault || f.isLocked}
                          onClick={() => setPendingDelete({ id: f.id, label: f.label })}
                        >
                          <Trash2 />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {f.isDefault || f.isLocked
                          ? 'Built-in fields cannot be deleted'
                          : 'Delete this field'}
                      </TooltipContent>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{pendingDelete?.label}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Every value stored in this field is dropped along with it. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() =>
                pendingDelete && remove.mutate({ fieldId: pendingDelete.id })
              }
            >
              <Trash2 />
              Delete field
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
