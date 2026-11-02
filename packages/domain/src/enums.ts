/**
 * Named replacements for Dokmee's integer discriminators. Dokmee's actual
 * integer values were not recovered (REVERSE-ENGINEERING.md §8), so these are
 * our own string enums; only the *concepts* are carried across.
 */

/** `Dms_FsNodes.SubjectType` */
export const NODE_KINDS = ['folder', 'document', 'link'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/** `Dms_CabinetIndexFields.ValueType` */
export const FIELD_TYPES = [
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
export type FieldType = (typeof FIELD_TYPES)[number];

/** Which physical column on `node_index_value` a field type lands in. */
export function storageSlotFor(
  type: FieldType,
): 'text' | 'number' | 'date' | 'boolean' {
  switch (type) {
    case 'number':
    case 'decimal':
    case 'autoNumber':
      return 'number';
    case 'date':
    case 'datetime':
      return 'date';
    case 'boolean':
      return 'boolean';
    default:
      return 'text';
  }
}

/** `Dms_Users.UserStatus` */
export const USER_STATUSES = ['active', 'disabled', 'locked', 'expired'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** `Dms_Users.UserType` */
export const USER_TYPES = ['local', 'activeDirectory', 'saml'] as const;
export type UserType = (typeof USER_TYPES)[number];

/** `Dms_FileCabinets.Status` */
export const CABINET_STATUSES = ['active', 'readOnly', 'offline'] as const;
export type CabinetStatus = (typeof CABINET_STATUSES)[number];

/** `Workflow_Tasks.Type` */
export const WORKFLOW_TASK_TYPES = [
  'review',
  'approval',
  'decision',
  'notify',
  'updateIndex',
  'stamp',
  'signature',
  'clone',
  'email',
  'rpa',
  'end',
] as const;
export type WorkflowTaskType = (typeof WORKFLOW_TASK_TYPES)[number];

/** `Workflow_Routings.Type` */
export const ROUTING_TYPES = ['always', 'onApprove', 'onReject', 'onDecision'] as const;
export type RoutingType = (typeof ROUTING_TYPES)[number];

export const WORKFLOW_INSTANCE_STATES = [
  'running',
  'completed',
  'cancelled',
  'error',
] as const;
export type WorkflowInstanceState = (typeof WORKFLOW_INSTANCE_STATES)[number];

/** `Retention_Job.ExpirationAction` */
export const RETENTION_ACTIONS = [
  'notify',
  'recycle',
  'deletePermanently',
  'updateIndex',
] as const;
export type RetentionAction = (typeof RETENTION_ACTIONS)[number];

/** `User_Notification.NotificationType` */
export const NOTIFICATION_TYPES = [
  'document',
  'workflow',
  'retention',
  'system',
  'share',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Audited verbs. Dokmee writes these to a per-cabinet audit table. */
export const AUDIT_ACTIONS = [
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
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Background queue kinds — one per Dokmee out-of-process service. */
export const JOB_KINDS = [
  'textExtraction',
  'ocr',
  'autoIndex',
  'dataExtraction',
  'dataExport',
  'email',
  'notification',
  'retention',
  'recycle',
  'aiSummary',
  'rpa',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATES = ['queued', 'running', 'done', 'failed'] as const;
export type JobState = (typeof JOB_STATES)[number];
