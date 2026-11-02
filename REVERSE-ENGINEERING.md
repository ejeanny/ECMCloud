# Dokmee ECM 7.8.3.27 — reverse-engineering findings

All statements below are tagged **[observed]** (read directly from the shipped
artifacts or the live database on this machine), **[inferred]** (a reading of
observed names/structure), or **[unknown]**.

## 1. Target identity [observed]

| Fact | Value |
|---|---|
| Product | Dokmee ECM (Office Gemini) |
| Version | 7.8.3.27 |
| Install root | `C:\Program Files\Office Gemini\Dokmee ECM` |
| Install size | 6 707 files, 2 914 MB |
| Web assembly | `webApp\bin\Dokmee.Ecm.Web.dll` |
| — SHA-256 | `4eb06b3de491011163030407f0a3ac53ee60a3addcdb3c2548fc3b25e5f4f62a` |
| — assembly | `Dokmee.Ecm.Web, Version=7.8.3.27`, PE/x86, CLR `v4.0.30319` |
| — MVID | `2ffd2848-dc99-433d-8b7a-366f04b117f2` |
| — metadata | 1 119 TypeDefs, 5 867 MethodDefs, 6 469 Fields, 1 057 Properties |
| REA evidence | `ev_4c9f8076bc1856b9091d7c56c589a2857aeb4eacf80ab8534e3cc99c2c6c0b80` (assembly-wide), `ev_d78eb59ddf6c09c78e40e109fb12194a988b8ff031361cd8be35ffcd638e793e` (`FileSystemController`) |

Sibling products installed (not analysed): Dokmee Capture 7.6.41.4, Dokmee ECM
Hub 7.7.7.3, Dokmee Smart Import 7.7.1.1, Dokmee ECM Outlook Add-in 7.6.7.3,
Dokmee DMS 6.6.5.663 (the predecessor generation), Dokmee Page Counter 2.2.0.1.

## 2. Deployment architecture [observed]

```
 Angular 21 SPA  ──HTTP──▶  ASP.NET MVC / Web API (.NET Framework 4.x, IIS)
 (Scripts/libs/main.*.js)         │
                                  ├─▶ SQL Server Express  (MSSQL16.SQLEXPRESS)
                                  │     • Dokmee_ECM              ← master DB
                                  │     • Dokmee_ECM_<cabinetGuid> ← one DB per cabinet
                                  │
                                  ├─▶ file repository   C:\Dokmee ECM Repository\<cabinetGuid>\
                                  │
                                  └─▶ 13 out-of-process Windows services (.exe)
```

Out-of-process workers found in the install root **[observed]**:
`AutoOcr`, `AutoIndex`, `DataExtraction`, `DataExport`, `Emailer`,
`Notification`, `Recycler`, `Retention`, `RPA`, `ActiveDirectory`,
`AIAutomatedSummary`, `BackupAndRestore`, `DatabaseUpdater`.
Each has its own NLog config and rolling log file, so the product is a
**queue-and-worker** design: the web tier writes a queue row, a service drains
it. `logs\dokmee.ecm.<service>.<n>.log` confirms every one of them has run here.

Third-party components in `webApp\bin` **[observed]**: PDFTron/Apryse PDFNet
(57 MB) and WebViewer 12.0.1 for rendering, ISYS (`ISYSreaders*.dll`) for text
extraction, IRIS `idrsocr16.dll` for OCR, Spire.Pdf/Doc/XLS/Presentation for
Office conversion, FFmpeg for media, Rappid 3.2.0 (JointJS) for the workflow
designer canvas, SignalR for push.

Front end **[observed, `webApp\package.json`]**: Angular 21.2, Angular Material,
`@ngx-translate`, `@pdftron/webviewer`, `@clientio/rappid`, `@swimlane/ngx-graph`,
`signalr`, `video.js`, `ng2-file-upload`, `idb`. Production bundles are run
through `javascript-obfuscator` 4.1 (`webpack-obfuscator`), so the shipped
`main.5cd464bb1e17d8b1.js` has control-flow flattening and a hex-escaped string
array — route literals are not recoverable from it directly. The API surface
below therefore comes from assembly metadata, not from the bundle.

## 3. Controller (API) surface [observed]

92 `*Controller` type names recovered from the `#Strings` heap of
`Dokmee.Ecm.Web.dll`. Grouped by concern:

| Area | Controllers |
|---|---|
| Documents & tree | `FileSystemController`, `FileSystemIndexingController`, `FileSystemSecurityController`, `FileUploadController`, `FileNotesController`, `FileRelationController`, `RecycleController`/`RecyclerController` |
| Cabinets & fields | `FileCabinetController`, `RepoFileCabinetController`, `IndexController`, `IndexingController`, `GlobalIndexController`, `RepoIndexController` |
| Identity | `SessionController`, `UserAccountController`, `SecurityController`, `RepoSecurityController`, `SAMLController` |
| Search | `AISearchController`, `AIDocumentHistoryController`, `AISearchHistoryController` |
| Workflow | `WorkflowController`, `GlobalWorkflowController` |
| Lifecycle | `RetentionController`, `AuditController`, `DataExportController`, `DataExtractionController` |
| Content ops | `OcrController`, `StampController`, `CabinetStampController`, `StampOpacityController`, `SignatureController`, `UserSignatureController`, `DocuSignController` |
| Automation | `RpaController`, `RpaQueueController`, `RpaSettingsController`, `RpaLogController`, `ConnectorController`, `AIAutomatedSummaryController`, `AIFileCreatorController` |
| Notifications | `EmailController`, `UserNotificationController`, `PushNotificationController`, `SignalRController` |
| Platform | `SettingsController`, `SystemSettingsController`, `SystemConfigurationController`, `ConnectionSettingsController`, `ThemeController`, `LicenseController`/`LicensingController`, `ReportController`, `HubController`, `InfoController`, `GettingStartedController`, `ServiceController` |

### `FileSystemController` — 170 methods [observed, REA]

Public actions (constructor/property accessors removed):

```
CreateDocument(Async)            UploadDocumentAsync           UploadSegmentAsync
ExtractMultiSegmentCompressedFiles  SyncSegments               RemovePartiallyExtractedFile
GetDocuments(Async)             GetDocumentInfo(s)(Async)      FileExists
DeleteDocument                  SendToRecycleBin               DeletePermanently(Async)
RestoreFiles(Async)             Restore
DownloadDocument(Async)         DownloadZippedDocuments(Async) DownloadDocumentAsPDFAsync
GetDocumentStreamAsync          ResolveStreamedVersionExtAsync DownloadFormAsync
ViewDocument(Async)             CloseDocument
GetDocumentFullText(Async)      UpdateDocumentDigitalSignatureStatus
CreatePrintVersion(Async)       CreatePrintFileApryseAsync
GetPagedDocuments(Async)        GetPagedDocumentsCountAsync
GetPagedUserFavorites(Async)    AddDocumentsToFavorites(Async) RemoveUserFavoriteDocuments(Async)
SearchDocuments(Async)          SearchMultipleCabinets(Async)
InsertToDocument                DeletePagesFromDocument        CreateTempDocument
ExportDataAndFilesAsync         ExportSearchResultsCSVAsync
```

Naming conventions **[observed]**: paired sync/`Async` overloads throughout,
`GetPaged…` + a separate `GetPaged…CountAsync` (count is a second round trip,
not part of the page envelope), chunked upload via `UploadSegmentAsync` +
`SyncSegments`. Two documented request DTOs in `Dokmee.Dms.Web.Controllers`:
`PageManipulationModelRequest` (with `PageManipulationActions`, `PageRotation`,
`PageRearrange`) and `UploadBlobFileChangeModelRequest`.

URL shape **[inferred]**: the three endpoint literals that survived
obfuscation — `gettingstarted/GetPagedSessionsAsync`,
`gettingstarted/DeleteSessionAsync`, `GlobalIndex/CreateGlobalIndexFieldAsync`,
`session/UpdateSessionStatus` — indicate `"{controller}/{action}"` RPC-style
routing, not REST resources. That is the single most important API-shape
finding for the rebuild: **Dokmee's API is already RPC**, which is why tRPC is
a natural target rather than a translation.

## 4. Data model [observed, live SQL Server]

### Master database `Dokmee_ECM` — 87 tables, 1 view, 441 stored procedures

Core identity and tenancy:

```
Dms_Users(UserId pk, ADGuid, UserName, FirstName, LastName, Email, Description,
          Salt varbinary, Password varbinary, WorkFactor int,
          ApplicationPasswordSalt, ApplicationPassword,
          PasswordChanged, IsTempPassword, TempPassword, IsApplicationTempPassword,
          ApplicationTempPassword, UserStatus int, ExpirationDate,
          ADProfileId, LanguageCode, UserType int, Created, Modified, Deleted)
Dms_Roles(RoleId pk, RoleName, RoleType tinyint, RoleTypeName, Description, ADProfileId, …)
Dms_Users_Roles(UserId, RoleId)
Dms_Profiles(ProfileId pk, ProfileType tinyint, ProfileName, …)
Dms_Roles_System_Rights(RoleId, RightCode int)
Dms_Users_Denied_SystemRights(…)          -- explicit deny overlay
Dms_Sessions(Id, TokenId, UserId, UserName, FirstName, LastName, Status,
             TokenLifeTime, ProtectedTicket, DeviceId, WindowGuid,
             IssuedDate, ExpiredDate, …)
```

Note **[observed]**: passwords are `varbinary` with a per-user `Salt` and an
explicit `WorkFactor` column — a bcrypt/PBKDF2-style scheme with a stored cost
factor. Each user has a **second** credential (`ApplicationPassword`) separate
from the web password. Sessions are **server-side rows** with a
`ProtectedTicket`, `DeviceId` and `WindowGuid` — a session table, not a
stateless JWT, and sessions are per browser *window*.

Cabinets:

```
Dms_FileCabinets(Guid pk, Name, Description, SqlInstance, Encrypted,
                 AllowDuplicateFileNames, IsMaster, SecuredStorage,
                 PrimaryRepo, SecondaryRepo, Status int, AllowCustomFolder,
                 DatabaseVersion, IsAutoIndex, IsFullTextEncrypted,
                 IsUserDateTimeIncludedInSignature, FolderNameDisplayLimit,
                 RepoEncrypted, EnableFullTextIndex, AICabinetDescription, isRPA, …)
Dms_Fc_Roles_Profiles(CabinetId, RoleId, ProfileId, IsRoleReadOnly, IsFileAccessDenied)
Dms_Fc_Owners, Dms_User_Denied_Fc, Dms_UsersPinnedCabinets
Dms_GlobalIndexFields(FieldGuid, FieldName, ValueType tinyint, IsAutoSorted, IsForcedMatch, …)
```

Observed cabinet rows on this machine: `test`, `demo`, `Forms`, `Invoices`,
`DSI_DOC`, `OCR`, `Forms` — each with `PrimaryRepo =
C:\Dokmee ECM Repository\<guid>` and its own `Dokmee_ECM_<guid-no-dashes>`
database name in the row.

Platform tables: `Dms_System_Audit_Records` plus **one audit table per cabinet**
(`Dokmee_ECM_Audit_Records_<guid>`), `Dms_Email_Queue` / `_Sent` /
`_Attachments` / `_Smtp_Setting` / `_User_Setting`, `Dms_Recycle_Queue`,
`Dms_Data_Extraction_Queue`, `Data_Export_Queue`, `AutoIndex_Settings_Queue`,
`Rpa_Queue` / `Rpa_Log`, `AI_Automated_Summary_Queue` / `_Log`,
`AI_Search_History` / `AI_Search_Conversation`, `Retention_Job`,
`Retention_Update_Index_Info`, `OcrSetting`, `OCRServiceScheduler`,
`Ocr_Language`, `Ocr_Language_Set`, `Ocr_Compression_Type`, `User_Notification`,
`User_Mobile_Notifications`, `Push_Notificaton_Tokens` (sic),
`Document_Notification_Settings`, `Document_Timespan_Trigger_Notification_Settings`,
`User_Favorite_Files`, `User_Recent_Files`, `User_Settings`,
`Dms_ThemeSettings`, `SystemSettings`, `System_Configurations`, `Watermark`,
`Signature`, `ESignature`, `Stamp_Opacity`, `IPAddress`, `FileRelationships`,
`FormsSettings`, `Search_Widget_Settings`, `AD_Groups`/`AD_Profiles`/
`AD_Role_Maps`/`AD_Exceptions`, `Envelope_Cabinet_Mapping` (DocuSign),
`Dms_DataPath_Credentials`, `Dms_Executed_Scripts`, `Upgrade_Track_Log`,
`Release_Message`, `User_Release`.

### Per-cabinet database `Dokmee_ECM_<cabinetGuid>` — 46 tables

The document store:

```
Dms_FsNodes(NodeGuid pk, TargetGuid, OriginalName nvarchar(1500), Ext, Length bigint,
            Pages int, FullText nvarchar(max), SubjectType tinyint, Bin int,
            SentFrom, SentTo, Cc, EmailSubject, SentOn,          -- email ingest
            IsCheckedOut, CheckedOut, IndexModified,
            CryptoKey varchar(max), CryptoVector varchar(max),   -- per-file envelope encryption
            Deleted, Restored, Created, Modified,
            DocuSignEnvelopId, DocuSignDocumentId, DocuSignSentUserId, IsSigned,
            HasDigitalSignature, TextExtractionDate,
            DokmeeForm, AllowFormAttachment, AttachmentRequired, CompleteOnlyOnce,
            AllowDownload, IsCompleterLinkExpiryEnabled, CompleterLinkExpiryDuration)
Dms_FsVersions(VersionFileId pk, FileId, OriginalName, Ext, FullText,
               MajorVersion int, MinorVersion int, UserId, Username, Comment,
               Pages, TextExtractionDate, Created, Modified, …)
Dms_FsCheckedOut(Id, FileId, Ext, UserId, OriginalName, Comment,
                 IsLiveCollabCheckedOut, Created, Modified)
Dms_FsNodeIndex(NodeGuid pk, Created, Modified,
                [Document Title] nvarchar(max), [Invoice number] nvarchar(510), …)
Dms_CabinetIndexFields(FileCabinetId, FileCabinetName, FieldGuid, Label, Description,
                       ValueType tinyint, IsDefault, IsRequired, IsRestricted,
                       IsLocked, Sort int, FolderLevel int, Operator int, …)
Dms_FileNotes(Guid, UserId, Username, NodeGuid, Notes, Created, Modfied)
Dms_SelectListValues, Auto_Number_Index_Fields, Dms_DocumentTitleMapping,
Prefill_Original_File_Name_Fields
```

Three findings here drive the rebuild's data design:

1. **`Dms_FsNodeIndex` is a dynamic-DDL table.** Its columns *are* the
   cabinet's index fields — this cabinet literally has columns named
   `Invoice number` and `Invoice supplier`. Adding an index field runs
   `ALTER TABLE ADD COLUMN`. **[observed]**
2. **The tree is self-referential through `TargetGuid`**, with `SubjectType`
   discriminating folder / document / link and `Bin` marking recycle state;
   `Deleted`/`Restored` timestamps are kept rather than rows being removed.
   **[inferred from column names and the presence of `Dms_Recycle_Queue`]**
3. **Full text is stored in-row** (`Dms_FsNodes.FullText`, and again per
   version), gated by `Dms_FileCabinets.EnableFullTextIndex` /
   `IsFullTextEncrypted`, with SQL Server's Full-Text Filter Daemon running.
   **[observed]**

Security, per cabinet:

```
Dms_Roles_Rights(RoleId, RightCode int, IsRestricted)
Dms_Users_Denied_Rights, Dms_Role_Right_Restriction, Role_Module_Rights
Dms_View_Restrictions(Guid, RoleId, FieldIds nvarchar(max),
                      RestrictionCondition varbinary, RestrictionCriteria varbinary)
```

`Dms_View_Restrictions` is **row-level security expressed as a serialised
predicate over index fields**, scoped to a role — i.e. "role X only sees
documents whose `Department` = Finance". The predicate is stored as an opaque
`varbinary` blob **[unknown: its serialisation format]**.

Workflow, per cabinet (23 tables):

```
Workflows(Guid, CabinetId, PublishedId, Name, Description, InError,
          IsLocked, LockedDate, LockedBy, …)
Workflow_Versions          -- design/published versioning
Workflow_Tasks(Guid, WfVersionId, Name, Type int, AllowSpecificReviewer,
               IsRpaEnabled, RpaUrlType)
Workflow_Routings(Guid, ActionId, Type int, TargetId, [Order] int, …)
Workflow_Triggers(Guid, WfId, IsNewDoc, IsIndexChanged, IsFromWF, ConditionType int)
Workflow_Trigger_Criteria, Workflow_Decision_Rules, Workflow_Rule_Conditions,
Workflow_Condition_Actions, Workflow_Task_Decisions, Workflow_Task_Todo,
Workflow_Instance_Todo, Workflow_Task_Notifications, Workflow_Task_JobFunction,
Workflow_JobFunctions, Workflow_JobFunction_Entity, Workflow_Admins
Workflow_Action_Email / _Stamp / _Signature / _Clone / _Update_Index / _DocuSign
```

Plus `WorkflowActiveInstances` in the **master** DB — running instances are
tracked centrally while definitions live per cabinet. **[observed]**

## 5. Permission model [observed, `Dms.Contracts.Security.dll`]

`RightCode` is an int enum. The member names, recovered from the assembly's
string heap, are the complete privilege vocabulary:

```
View_Open  Launch_Document  Launch_Viewer  Dokmee_Viewer  Print_Document
Copy_Document  Move_Document  Delete_Document  Edit_Document  Merge_Document
Split_Document  Extract_Pages  Email_Document  Document_Share  Attach_Files
Save_Document_New_Version  Save_Document_Overwrite  Save_Document_Save_As
Save_Document_Revert_Version  Folders_Files_View_Versions
Create_Folder  Import_With_Indexing  Virtual_Printer
Add_Annotation  Edit_Annotation  Delete_Annotation  Burn_Annotation
Add_Stamp  Custom_Stamps_Create_Edit  Bates_Label  Zone_Ocr
View_FileNotes  Edit_FileNotes  Print_File_Notes
Create_Index_Field  Edit_Index_Field  Delete_Index_Field  Update_IndexValue
Find_Replace_IndexValue  Index_Field_Management  Index_Administration
Create_Database  Delete_Database  Database_Administration  Connection_Setting
User_Administration  Folder_Document_Level_User_Restrictions
Cut_Restore_Recycle_Bin  Empty_Recycle_Bin
View_Audit_Log  Print_Audit_Log  Export_Audit_Log
Print_Search_Results  Export_Search_Results
New_Edit_Scheduled_Jobs  Delete_Scheduled_Jobs
Enable_Disable_Scheduled_Jobs  Run_Now_Scheduled_Jobs
File_Retention_Manage_Settings  File_Retention_Expired_File_Queue
Workflow_Management  Manage_Addin  Backup_Settings  Backup_Logs  Services_Logs
```

Built-in roles **[observed]**: `Admin_Role`, `Assistant_Admin_Role`,
`Users_Role`, `Data_Export_Role`, and cloud variants `Cloud_Admin_Role`,
`Cloud_Assistant_Admin_Role`, `Cloud_Users_Role`.

Evaluation is a **grant-then-deny** overlay **[inferred from table names]**:
role grants in `Dms_Roles_System_Rights` / `Dms_Roles_Rights`, minus
`Dms_Users_Denied_SystemRights` / `Dms_Users_Denied_Rights`, minus
`Dms_User_Denied_Fc` (whole-cabinet denial), further narrowed by
`Dms_View_Restrictions` (row-level) and `Dms_Fc_Roles_Profiles.IsRoleReadOnly` /
`IsFileAccessDenied`.

## 6. What the rebuild keeps, and what it deliberately changes

Kept, because it is the product's actual shape:

- Cabinet as the tenancy and configuration boundary; per-cabinet index-field
  schemas, roles/rights, workflows and audit.
- Node tree with folder/document/link discriminator, soft delete into a recycle
  bin, check-out/check-in, major.minor versioning with per-version full text.
- Server-side sessions with a stored token, device and expiry.
- Grant-then-deny privilege evaluation over the privilege vocabulary above.
- RPC-shaped API (`area.action`), paged list + separate count.
- Queue-and-worker for OCR, text extraction, email, retention, export,
  notification.
- Blob storage on the filesystem under a per-cabinet repository root, with the
  database holding only metadata and a per-file encryption envelope.

Changed on purpose, with the reason:

| Dokmee | Rebuild | Why |
|---|---|---|
| One SQL Server **database per cabinet**, created at runtime | One database, `cabinetId` column | Runtime `CREATE DATABASE` makes migrations, backup and connection pooling intractable; nothing in the model needs physical separation. |
| `Dms_FsNodeIndex` columns added by **`ALTER TABLE`** per index field | `node_index_value` rows, typed per `ValueType` | Dynamic DDL defeats a typed client, migrations and least-privilege DB users. |
| Audit table per cabinet | One `audit_record` table partitioned logically by `cabinetId` | Same reason. |
| 441 stored procedures | Prisma + TypeScript services | Business rules belong where they can be type-checked and tested. |
| `RestrictionCondition` / `RestrictionCriteria` as opaque `varbinary` | JSON predicate with a Zod schema | The stored format is **unknown**; a declared schema is required anyway. |
| Second "application password" per user | Single credential + API tokens | The two-password split has no observed purpose a scoped token does not serve better. |
| Angular 21 SPA, obfuscated | Next.js 16 App Router, React Server Components | As requested. |
| ASP.NET MVC RPC endpoints | tRPC v11 over Fastify | As requested; preserves RPC shape with end-to-end types. |

## 7. Coverage of this investigation

Answered: deployment topology, service decomposition, controller inventory,
`FileSystemController` action surface, master and per-cabinet relational
schemas with column types, privilege vocabulary and built-in roles, storage
layout, third-party component inventory, front-end stack.

Partially answered: exact HTTP route templates and verbs (RPC shape inferred
from four surviving literals plus controller/action naming, not read from route
attributes); per-action request/response DTO shapes (two documented request
types only).

Unresolved: the serialisation of `Dms_View_Restrictions.RestrictionCondition` /
`RestrictionCriteria`; the semantics of the integer enums `SubjectType`, `Bin`,
`Status`, `UserType`, `RoleType`, `ProfileType`, `ValueType`,
`Workflow_Tasks.Type`, `Workflow_Routings.Type`, `ConditionType`,
`NotificationType`, `ActionType`, `ExpirationAction` — the rebuild assigns its
own named enum values rather than guessing Dokmee's integers; the licensing
scheme (`Dokmee.Ecm.License.dll`); the Hub/Capture/Outlook integration
protocols. No runtime observation was performed — nothing here claims to have
watched the application execute.

## 8. Method

Static analysis only, against shipped artifacts and the local database:

- REA `inspect_managed_members` on `Dokmee.Ecm.Web.dll` (summary, then
  `type_names`-scoped member decode of `FileSystemController`) for assembly
  identity, metadata counts and the action list.
- `#Strings`-heap extraction from `Dokmee.Ecm.Web.dll` and
  `Dms.Contracts.Security.dll` for the controller and privilege vocabularies.
- `sqlcmd` against `localhost\SQLEXPRESS` with Windows auth, reading
  `sys.tables` / `sys.columns` / `sys.databases` / `sys.procedures` and the
  `Dms_FileCabinets` configuration rows.
- Shipped `package.json` and `webApp` directory inventory for the front-end
  stack and deployment layout.

The application was never launched, no process was attached or instrumented, no
file in the install was modified, and the connection-strings file was
deliberately not read.
