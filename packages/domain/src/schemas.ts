import { z } from 'zod';
import {
  AUDIT_ACTIONS,
  CABINET_STATUSES,
  FIELD_TYPES,
  JOB_KINDS,
  NODE_KINDS,
  NOTIFICATION_TYPES,
  RETENTION_ACTIONS,
  ROUTING_TYPES,
  USER_STATUSES,
  USER_TYPES,
  WORKFLOW_TASK_TYPES,
} from './enums.js';
import { RIGHTS } from './rights.js';

export const uuid = z.string().uuid();
export const rightSchema = z.enum(RIGHTS);
export const nodeKindSchema = z.enum(NODE_KINDS);
export const fieldTypeSchema = z.enum(FIELD_TYPES);

/** Paging envelope. Dokmee splits page and count into two calls; we keep a
 *  cursor list and expose count as its own procedure to mirror that. */
export const pageInput = z.object({
  skip: z.number().int().min(0).default(0),
  take: z.number().int().min(1).max(500).default(50),
});
export type PageInput = z.infer<typeof pageInput>;

export const sortInput = z.object({
  /** Either a built-in column or `field:<indexFieldId>`. */
  by: z.string().min(1).default('modified'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});

// --- auth ---------------------------------------------------------------

export const loginInput = z.object({
  userName: z.string().min(1).max(256),
  password: z.string().min(1).max(512),
  deviceId: z.string().max(256).optional(),
});

export const changePasswordInput = z.object({
  currentPassword: z.string().min(1).max(512),
  newPassword: z.string().min(10).max(512),
});

// --- cabinets -----------------------------------------------------------

export const createCabinetInput = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(2000).optional(),
  allowDuplicateFileNames: z.boolean().default(false),
  allowCustomFolder: z.boolean().default(true),
  enableFullTextIndex: z.boolean().default(true),
  repoEncrypted: z.boolean().default(false),
  folderNameDisplayLimit: z.number().int().min(10).max(255).default(70),
});

export const updateCabinetInput = createCabinetInput.partial().extend({
  cabinetId: uuid,
  status: z.enum(CABINET_STATUSES).optional(),
});

// --- index fields -------------------------------------------------------

export const createIndexFieldInput = z.object({
  cabinetId: uuid,
  label: z.string().min(1).max(256),
  description: z.string().max(1000).optional(),
  type: fieldTypeSchema,
  isRequired: z.boolean().default(false),
  isRestricted: z.boolean().default(false),
  isLocked: z.boolean().default(false),
  /** >0 makes the field a folder level, as `Dms_CabinetIndexFields.FolderLevel`. */
  folderLevel: z.number().int().min(0).max(16).default(0),
  sort: z.number().int().min(0).default(0),
  selectValues: z.array(z.string().min(1).max(512)).optional(),
});

export const updateIndexFieldInput = createIndexFieldInput
  .omit({ cabinetId: true, type: true })
  .partial()
  .extend({ fieldId: uuid });

// --- nodes --------------------------------------------------------------

export const indexValueSchema = z.object({
  fieldId: uuid,
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});
export type IndexValue = z.infer<typeof indexValueSchema>;

export const listNodesInput = z
  .object({
    cabinetId: uuid,
    parentId: uuid.nullable().default(null),
    kind: nodeKindSchema.optional(),
    inRecycleBin: z.boolean().default(false),
  })
  .merge(pageInput)
  .extend({ sort: sortInput.optional() });

export const createFolderInput = z.object({
  cabinetId: uuid,
  parentId: uuid.nullable(),
  name: z.string().min(1).max(1500),
});

export const renameNodeInput = z.object({
  nodeId: uuid,
  name: z.string().min(1).max(1500),
});

export const moveNodesInput = z.object({
  nodeIds: z.array(uuid).min(1).max(1000),
  targetParentId: uuid.nullable(),
});

export const copyNodesInput = moveNodesInput;

export const nodeIdsInput = z.object({
  nodeIds: z.array(uuid).min(1).max(1000),
});

export const setIndexValuesInput = z.object({
  nodeId: uuid,
  values: z.array(indexValueSchema).max(500),
});

export const findReplaceIndexInput = z.object({
  cabinetId: uuid,
  fieldId: uuid,
  find: z.string().min(1).max(512),
  replace: z.string().max(512),
  matchCase: z.boolean().default(false),
  /** Preview without writing. */
  dryRun: z.boolean().default(true),
});

// --- versions & check-out ----------------------------------------------

export const checkOutInput = z.object({
  nodeId: uuid,
  comment: z.string().max(2000).optional(),
});

export const checkInInput = z.object({
  nodeId: uuid,
  /** Minor bump by default, matching `MajorVersion`/`MinorVersion`. */
  bump: z.enum(['major', 'minor', 'overwrite']).default('minor'),
  comment: z.string().max(2000).optional(),
  /** Upload id produced by `upload.begin` / `upload.segment` / `upload.finish`. */
  uploadId: uuid.optional(),
});

export const revertVersionInput = z.object({
  nodeId: uuid,
  versionId: uuid,
  comment: z.string().max(2000).optional(),
});

// --- chunked upload -----------------------------------------------------
// Mirrors Dokmee's UploadDocumentAsync / UploadSegmentAsync / SyncSegments.

export const beginUploadInput = z.object({
  cabinetId: uuid,
  parentId: uuid.nullable(),
  fileName: z.string().min(1).max(1500),
  byteLength: z.number().int().min(0).max(50 * 1024 * 1024 * 1024),
  segmentCount: z.number().int().min(1).max(100_000),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

export const finishUploadInput = z.object({
  uploadId: uuid,
  values: z.array(indexValueSchema).max(500).optional(),
});

// --- search -------------------------------------------------------------

export const searchInput = z
  .object({
    /** One or more cabinets — Dokmee exposes this as SearchMultipleCabinets. */
    cabinetIds: z.array(uuid).min(1).max(50),
    /** Free text, matched against name and extracted full text. */
    text: z.string().max(2000).optional(),
    fullText: z.boolean().default(true),
    fields: z
      .array(
        z.object({
          fieldId: uuid,
          operator: z.enum([
            'eq',
            'neq',
            'contains',
            'startsWith',
            'endsWith',
            'gt',
            'gte',
            'lt',
            'lte',
            'isEmpty',
            'isNotEmpty',
          ]),
          value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
        }),
      )
      .max(50)
      .optional(),
    createdFrom: z.coerce.date().optional(),
    createdTo: z.coerce.date().optional(),
    includeRecycleBin: z.boolean().default(false),
  })
  .merge(pageInput)
  .extend({ sort: sortInput.optional() });

// --- notes, favourites --------------------------------------------------

export const addNoteInput = z.object({
  nodeId: uuid,
  notes: z.string().min(1).max(20_000),
});

export const editNoteInput = z.object({
  noteId: uuid,
  notes: z.string().min(1).max(20_000),
});

// --- users, roles -------------------------------------------------------

export const createUserInput = z.object({
  userName: z.string().min(1).max(256),
  firstName: z.string().max(256).default(''),
  lastName: z.string().max(256).default(''),
  email: z.string().email().max(320).optional(),
  description: z.string().max(1000).optional(),
  password: z.string().min(10).max(512).optional(),
  isTempPassword: z.boolean().default(true),
  userType: z.enum(USER_TYPES).default('local'),
  status: z.enum(USER_STATUSES).default('active'),
  expirationDate: z.coerce.date().nullable().optional(),
  languageCode: z.string().max(8).optional(),
  roleIds: z.array(uuid).max(100).default([]),
});

export const updateUserInput = createUserInput
  .omit({ password: true, userName: true })
  .partial()
  .extend({ userId: uuid });

export const createRoleInput = z.object({
  roleName: z.string().min(1).max(256),
  description: z.string().max(1000).optional(),
  systemRights: z.array(rightSchema).default([]),
});

export const setCabinetRoleRightsInput = z.object({
  cabinetId: uuid,
  roleId: uuid,
  rights: z.array(rightSchema),
  isReadOnly: z.boolean().default(false),
  isFileAccessDenied: z.boolean().default(false),
});

export const restrictionClauseSchema = z.object({
  fieldId: uuid,
  operator: z.enum([
    'eq',
    'neq',
    'contains',
    'startsWith',
    'endsWith',
    'gt',
    'gte',
    'lt',
    'lte',
    'in',
    'isEmpty',
    'isNotEmpty',
  ]),
  value: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])
    .optional(),
});

export const setViewRestrictionInput = z.object({
  cabinetId: uuid,
  roleId: uuid,
  combine: z.enum(['and', 'or']).default('and'),
  clauses: z.array(restrictionClauseSchema).max(50),
});

// --- audit --------------------------------------------------------------

export const auditQueryInput = z
  .object({
    cabinetId: uuid.optional(),
    userId: uuid.optional(),
    nodeId: uuid.optional(),
    actions: z.array(z.enum(AUDIT_ACTIONS)).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .merge(pageInput);

// --- retention ----------------------------------------------------------

export const retentionJobInput = z.object({
  cabinetId: uuid,
  name: z.string().min(1).max(256),
  isEnabled: z.boolean().default(false),
  expirationAction: z.enum(RETENTION_ACTIONS),
  years: z.number().int().min(0).max(200).default(0),
  months: z.number().int().min(0).max(1200).default(0),
  days: z.number().int().min(0).max(40000).default(0),
  /** Index field holding the date retention counts from. */
  retentionDateFieldId: uuid.nullable(),
  combine: z.enum(['and', 'or']).default('and'),
  clauses: z.array(restrictionClauseSchema).max(50).default([]),
});

// --- workflow -----------------------------------------------------------

export const workflowTaskInput = z.object({
  name: z.string().min(1).max(256),
  type: z.enum(WORKFLOW_TASK_TYPES),
  assigneeRoleIds: z.array(uuid).max(100).default([]),
  assigneeUserIds: z.array(uuid).max(100).default([]),
  allowSpecificReviewer: z.boolean().default(false),
  /** Free-form per-type configuration, validated by the task handler. */
  config: z.record(z.unknown()).default({}),
});

export const workflowRoutingInput = z.object({
  fromTaskKey: z.string().min(1).max(64),
  toTaskKey: z.string().min(1).max(64).nullable(),
  type: z.enum(ROUTING_TYPES).default('always'),
  order: z.number().int().min(0).default(0),
});

export const saveWorkflowInput = z.object({
  cabinetId: uuid,
  workflowId: uuid.optional(),
  name: z.string().min(1).max(256),
  description: z.string().max(2000).optional(),
  trigger: z.object({
    onNewDocument: z.boolean().default(false),
    onIndexChanged: z.boolean().default(false),
    combine: z.enum(['and', 'or']).default('and'),
    clauses: z.array(restrictionClauseSchema).max(50).default([]),
  }),
  tasks: z.array(workflowTaskInput.extend({ key: z.string().min(1).max(64) })).max(200),
  routings: z.array(workflowRoutingInput).max(500),
});

export const startWorkflowInput = z.object({
  workflowId: uuid,
  nodeIds: z.array(uuid).min(1).max(500),
});

export const completeTodoInput = z.object({
  todoId: uuid,
  decision: z.enum(['approve', 'reject', 'choose']).default('approve'),
  /** Set when `decision` is `choose`. */
  choice: z.string().max(256).optional(),
  comment: z.string().max(4000).optional(),
});

// --- notifications & jobs ----------------------------------------------

export const notificationQueryInput = z
  .object({
    unreadOnly: z.boolean().default(false),
    types: z.array(z.enum(NOTIFICATION_TYPES)).optional(),
  })
  .merge(pageInput);

export const enqueueJobInput = z.object({
  kind: z.enum(JOB_KINDS),
  cabinetId: uuid.optional(),
  nodeId: uuid.optional(),
  payload: z.record(z.unknown()).default({}),
});
