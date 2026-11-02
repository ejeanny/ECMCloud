/**
 * Privilege vocabulary.
 *
 * The member names are the ones recovered from `Dms.Contracts.Security.dll`
 * in Dokmee ECM 7.8.3.27, so a Dokmee role definition maps across by name.
 * The *numeric* codes Dokmee stores in `RightCode` were not recovered, so
 * these are string codes of our own — see REVERSE-ENGINEERING.md §8.
 */
export const RIGHTS = [
  // --- viewing ---------------------------------------------------------
  'View_Open',
  'Launch_Document',
  'Launch_Viewer',
  'Print_Document',
  // --- document lifecycle ---------------------------------------------
  'Copy_Document',
  'Move_Document',
  'Delete_Document',
  'Edit_Document',
  'Merge_Document',
  'Split_Document',
  'Extract_Pages',
  'Email_Document',
  'Document_Share',
  'Attach_Files',
  'Import_With_Indexing',
  'Create_Folder',
  // --- versions --------------------------------------------------------
  'Save_Document_New_Version',
  'Save_Document_Overwrite',
  'Save_Document_Save_As',
  'Save_Document_Revert_Version',
  'Folders_Files_View_Versions',
  // --- annotations & marks --------------------------------------------
  'Add_Annotation',
  'Edit_Annotation',
  'Delete_Annotation',
  'Burn_Annotation',
  'Add_Stamp',
  'Custom_Stamps_Create_Edit',
  'Bates_Label',
  'Zone_Ocr',
  // --- notes -----------------------------------------------------------
  'View_FileNotes',
  'Edit_FileNotes',
  'Print_File_Notes',
  // --- index fields ----------------------------------------------------
  'Create_Index_Field',
  'Edit_Index_Field',
  'Delete_Index_Field',
  'Update_IndexValue',
  'Find_Replace_IndexValue',
  'Index_Field_Management',
  'Index_Administration',
  // --- recycle bin -----------------------------------------------------
  'Cut_Restore_Recycle_Bin',
  'Empty_Recycle_Bin',
  // --- search ----------------------------------------------------------
  'Print_Search_Results',
  'Export_Search_Results',
  // --- audit -----------------------------------------------------------
  'View_Audit_Log',
  'Print_Audit_Log',
  'Export_Audit_Log',
  // --- scheduled jobs --------------------------------------------------
  'New_Edit_Scheduled_Jobs',
  'Delete_Scheduled_Jobs',
  'Enable_Disable_Scheduled_Jobs',
  'Run_Now_Scheduled_Jobs',
  // --- retention -------------------------------------------------------
  'File_Retention_Manage_Settings',
  'File_Retention_Expired_File_Queue',
  // --- workflow --------------------------------------------------------
  'Workflow_Management',
  // --- administration --------------------------------------------------
  'Create_Database',
  'Delete_Database',
  'Database_Administration',
  'Connection_Setting',
  'User_Administration',
  'Folder_Document_Level_User_Restrictions',
  'Backup_Settings',
  'Backup_Logs',
  'Services_Logs',
  'Manage_Addin',
] as const;

export type Right = (typeof RIGHTS)[number];

/** Rights that are meaningful only at the system level, not per cabinet. */
export const SYSTEM_RIGHTS = [
  'Create_Database',
  'Delete_Database',
  'Database_Administration',
  'Connection_Setting',
  'User_Administration',
  'Backup_Settings',
  'Backup_Logs',
  'Services_Logs',
  'Manage_Addin',
  'View_Audit_Log',
  'Print_Audit_Log',
  'Export_Audit_Log',
  'New_Edit_Scheduled_Jobs',
  'Delete_Scheduled_Jobs',
  'Enable_Disable_Scheduled_Jobs',
  'Run_Now_Scheduled_Jobs',
] as const satisfies readonly Right[];

export type SystemRight = (typeof SYSTEM_RIGHTS)[number];

const SYSTEM_RIGHT_SET: ReadonlySet<string> = new Set(SYSTEM_RIGHTS);

export function isSystemRight(right: Right): right is SystemRight {
  return SYSTEM_RIGHT_SET.has(right);
}

/** Rights that apply inside a cabinet. */
export const CABINET_RIGHTS = RIGHTS.filter(
  (r): r is Exclude<Right, SystemRight> => !SYSTEM_RIGHT_SET.has(r),
);

/**
 * The built-in roles Dokmee ships. `Admin_Role` is deliberately *not* a
 * right set — an administrator is resolved by `isAdministrator`, so adding a
 * right to RIGHTS never silently excludes admins.
 */
export const BUILTIN_ROLES = {
  Admin_Role: { description: 'Full system and cabinet administration.' },
  Assistant_Admin_Role: {
    description: 'Cabinet administration without system configuration.',
  },
  Users_Role: { description: 'Day-to-day document work.' },
  Data_Export_Role: { description: 'Read and export only.' },
} as const;

export type BuiltinRoleName = keyof typeof BUILTIN_ROLES;

export const BUILTIN_ROLE_RIGHTS: Record<BuiltinRoleName, readonly Right[]> = {
  Admin_Role: RIGHTS,
  Assistant_Admin_Role: [
    ...CABINET_RIGHTS,
    'View_Audit_Log',
    'Print_Audit_Log',
    'Export_Audit_Log',
    'New_Edit_Scheduled_Jobs',
    'Enable_Disable_Scheduled_Jobs',
    'Run_Now_Scheduled_Jobs',
  ],
  Users_Role: [
    'View_Open',
    'Launch_Document',
    'Launch_Viewer',
    'Print_Document',
    'Copy_Document',
    'Move_Document',
    'Edit_Document',
    'Email_Document',
    'Attach_Files',
    'Import_With_Indexing',
    'Create_Folder',
    'Save_Document_New_Version',
    'Save_Document_Save_As',
    'Folders_Files_View_Versions',
    'Add_Annotation',
    'Edit_Annotation',
    'Add_Stamp',
    'View_FileNotes',
    'Edit_FileNotes',
    'Update_IndexValue',
    'Cut_Restore_Recycle_Bin',
    'Print_Search_Results',
  ],
  Data_Export_Role: [
    'View_Open',
    'Launch_Viewer',
    'Print_Document',
    'Print_Search_Results',
    'Export_Search_Results',
    'Folders_Files_View_Versions',
    'View_FileNotes',
  ],
};
