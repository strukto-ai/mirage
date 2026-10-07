// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

export * from '@struktoai/mirage-core'
// Named rather than left to the `export *` above: the three VFS classes come
// through it, but core's front door carries no config type of theirs, so
// dropping these lines would take them out of this package's API too.
export {
  normalizeAirtableConfig,
  redactAirtableConfig,
} from '@struktoai/mirage-core/core/airtable/config'
export type {
  AirtableConfig,
  AirtableConfigRedacted,
} from '@struktoai/mirage-core/core/airtable/config'
export type { AirtableVFSState } from '@struktoai/mirage-core/vfs/airtable/airtable'
export type { Mem0Config } from '@struktoai/mirage-core/vfs/mem0/config'
export type { OneDriveConfig } from '@struktoai/mirage-core/accessor/onedrive'
export type { SharePointConfig } from '@struktoai/mirage-core/accessor/sharepoint'
export { Workspace } from './workspace.ts'
export { OPFSVFS, type OPFSVFSOptions, type OPFSVFSState } from './vfs/opfs/opfs.ts'
export { PROMPT as OPFS_PROMPT } from './vfs/opfs/prompt.ts'
export { OPFSAccessor } from './accessor/opfs.ts'
export { OPFS_COMMANDS } from './commands/builtin/opfs/index.ts'
export { S3VFS, type S3VFSState } from './vfs/s3/s3.ts'
export { PROMPT as S3_BROWSER_PROMPT } from './vfs/s3/prompt.ts'
export { S3_COMMANDS } from '@struktoai/mirage-core/commands/builtin/s3/index'
export {
  normalizeS3Config,
  redactConfig as redactS3Config,
  type S3BrowserOperation,
  type S3BrowserPresignedUrlProvider,
  type S3BrowserSignOptions,
  type S3Config,
  type S3ConfigRedacted,
} from './vfs/s3/config.ts'
export { GCSVFS, type GCSVFSState } from './vfs/gcs/gcs.ts'
export { PROMPT as GCS_BROWSER_PROMPT } from './vfs/gcs/prompt.ts'
export {
  redactGcsConfig,
  gcsToS3Config,
  type GCSConfig,
  type GCSConfigRedacted,
} from './vfs/gcs/config.ts'
export { R2VFS, type R2VFSState } from './vfs/r2/r2.ts'
export { PROMPT as R2_BROWSER_PROMPT } from './vfs/r2/prompt.ts'
export {
  redactR2Config,
  r2ToS3Config,
  resolvedR2Endpoint,
  type R2Config,
  type R2ConfigRedacted,
} from './vfs/r2/config.ts'
export { OCIVFS, type OCIVFSState } from './vfs/oci/oci.ts'
export { PROMPT as OCI_BROWSER_PROMPT } from './vfs/oci/prompt.ts'
export {
  redactOciConfig,
  ociToS3Config,
  resolvedOciEndpoint,
  type OCIConfig,
  type OCIConfigRedacted,
} from './vfs/oci/config.ts'
export { SupabaseVFS, type SupabaseVFSState } from './vfs/supabase/supabase.ts'
export { PROMPT as SUPABASE_BROWSER_PROMPT } from './vfs/supabase/prompt.ts'
export {
  redactSupabaseConfig,
  supabaseToS3Config,
  resolvedSupabaseEndpoint,
  type SupabaseConfig,
  type SupabaseConfigRedacted,
} from './vfs/supabase/config.ts'
export { MinIOVFS, type MinIOVFSState } from './vfs/minio/minio.ts'
export { PROMPT as MINIO_BROWSER_PROMPT } from './vfs/minio/prompt.ts'
export {
  redactMinIOConfig,
  minioToS3Config,
  type MinIOConfig,
  type MinIOConfigRedacted,
} from './vfs/minio/config.ts'
export { SeaweedFSVFS, type SeaweedFSVFSState } from './vfs/seaweedfs/seaweedfs.ts'
export { PROMPT as SEAWEEDFS_BROWSER_PROMPT } from './vfs/seaweedfs/prompt.ts'
export {
  redactSeaweedFSConfig,
  seaweedfsToS3Config,
  type SeaweedFSConfig,
  type SeaweedFSConfigRedacted,
} from './vfs/seaweedfs/config.ts'
export { CephVFS, type CephVFSState } from './vfs/ceph/ceph.ts'
export { PROMPT as CEPH_BROWSER_PROMPT } from './vfs/ceph/prompt.ts'
export {
  redactCephConfig,
  cephToS3Config,
  type CephConfig,
  type CephConfigRedacted,
} from './vfs/ceph/config.ts'
export { WasabiVFS, type WasabiVFSState } from './vfs/wasabi/wasabi.ts'
export { PROMPT as WASABI_BROWSER_PROMPT } from './vfs/wasabi/prompt.ts'
export {
  redactWasabiConfig,
  wasabiToS3Config,
  resolvedWasabiEndpoint,
  type WasabiConfig,
  type WasabiConfigRedacted,
} from './vfs/wasabi/config.ts'
export { BackblazeVFS, type BackblazeVFSState } from './vfs/backblaze/backblaze.ts'
export { PROMPT as BACKBLAZE_BROWSER_PROMPT } from './vfs/backblaze/prompt.ts'
export {
  redactBackblazeConfig,
  backblazeToS3Config,
  resolvedBackblazeEndpoint,
  type BackblazeConfig,
  type BackblazeConfigRedacted,
} from './vfs/backblaze/config.ts'
export { DigitalOceanVFS, type DigitalOceanVFSState } from './vfs/digitalocean/digitalocean.ts'
export { PROMPT as DIGITALOCEAN_BROWSER_PROMPT } from './vfs/digitalocean/prompt.ts'
export {
  redactDigitalOceanConfig,
  digitalOceanToS3Config,
  resolvedDigitalOceanEndpoint,
  type DigitalOceanConfig,
  type DigitalOceanConfigRedacted,
} from './vfs/digitalocean/config.ts'
export { TencentVFS, type TencentVFSState } from './vfs/tencent/tencent.ts'
export { PROMPT as TENCENT_BROWSER_PROMPT } from './vfs/tencent/prompt.ts'
export {
  redactTencentConfig,
  tencentToS3Config,
  resolvedTencentEndpoint,
  type TencentConfig,
  type TencentConfigRedacted,
} from './vfs/tencent/config.ts'
export { AliyunVFS, type AliyunVFSState } from './vfs/aliyun/aliyun.ts'
export { PROMPT as ALIYUN_BROWSER_PROMPT } from './vfs/aliyun/prompt.ts'
export {
  redactAliyunConfig,
  aliyunToS3Config,
  resolvedAliyunEndpoint,
  type AliyunConfig,
  type AliyunConfigRedacted,
} from './vfs/aliyun/config.ts'
export { ScalewayVFS, type ScalewayVFSState } from './vfs/scaleway/scaleway.ts'
export { PROMPT as SCALEWAY_BROWSER_PROMPT } from './vfs/scaleway/prompt.ts'
export {
  redactScalewayConfig,
  scalewayToS3Config,
  resolvedScalewayEndpoint,
  type ScalewayConfig,
  type ScalewayConfigRedacted,
} from './vfs/scaleway/config.ts'
export { QingStorVFS, type QingStorVFSState } from './vfs/qingstor/qingstor.ts'
export { PROMPT as QINGSTOR_BROWSER_PROMPT } from './vfs/qingstor/prompt.ts'
export {
  redactQingStorConfig,
  qingStorToS3Config,
  resolvedQingStorEndpoint,
  type QingStorConfig,
  type QingStorConfigRedacted,
} from './vfs/qingstor/config.ts'
export { SlackVFS, type SlackVFSState } from './vfs/slack/slack.ts'
export {
  normalizeSlackConfig,
  redactSlackConfig,
  type SlackConfig,
  type SlackConfigRedacted,
} from './vfs/slack/config.ts'
export { DiscordVFS, type DiscordVFSState } from './vfs/discord/discord.ts'
export {
  normalizeDiscordConfig,
  redactDiscordConfig,
  type DiscordConfig,
  type DiscordConfigRedacted,
} from './vfs/discord/config.ts'
export { PostgresVFS, type PostgresVFSOptions } from './vfs/postgres/postgres.ts'
export { NeonPgDriver } from './vfs/postgres/neon_driver.ts'
export { MongoDBVFS, type MongoDBVFSOptions } from './vfs/mongodb/mongodb.ts'
export { HttpMongoDriver, type HttpMongoDriverOptions } from './vfs/mongodb/http_driver.ts'
export { TrelloVFS, type TrelloVFSState } from '@struktoai/mirage-core/vfs/trello/trello'
export {
  normalizeTrelloConfig,
  redactTrelloConfig,
  type TrelloConfig,
  type TrelloConfigRedacted,
} from '@struktoai/mirage-core/vfs/trello/config'
export { LinearVFS, type LinearVFSState } from '@struktoai/mirage-core/vfs/linear/linear'
export {
  normalizeLinearConfig,
  redactLinearConfig,
} from '@struktoai/mirage-core/core/linear/config'
export type { LinearConfig, LinearConfigRedacted } from '@struktoai/mirage-core/core/linear/config'
export { NotionVFS, type NotionVFSState } from './vfs/notion/notion.ts'
export {
  normalizeNotionConfig,
  redactNotionConfig,
  type NotionConfig,
  type NotionConfigRedacted,
} from './vfs/notion/config.ts'
export { LangfuseVFS, type LangfuseVFSState } from '@struktoai/mirage-core/vfs/langfuse/langfuse'
export {
  normalizeLangfuseConfig,
  redactLangfuseConfig,
  type LangfuseConfig,
  type LangfuseConfigRedacted,
} from '@struktoai/mirage-core/vfs/langfuse/config'
export { GitHubVFS, type GitHubVFSState } from '@struktoai/mirage-core/vfs/github/github'
export {
  normalizeGitHubConfig,
  redactGitHubConfig,
  type GitHubConfig,
  type GitHubConfigRedacted,
} from '@struktoai/mirage-core/core/github/config'
export { GDocsVFS, type GDocsVFSState } from '@struktoai/mirage-core/vfs/gdocs/gdocs'
export {
  normalizeGDocsConfig,
  redactGDocsConfig,
  type GDocsConfig,
  type GDocsConfigRedacted,
} from '@struktoai/mirage-core/vfs/gdocs/config'
export { GSheetsVFS, type GSheetsVFSState } from '@struktoai/mirage-core/vfs/gsheets/gsheets'
export {
  normalizeGSheetsConfig,
  redactGSheetsConfig,
  type GSheetsConfig,
  type GSheetsConfigRedacted,
} from '@struktoai/mirage-core/vfs/gsheets/config'
export { GSlidesVFS, type GSlidesVFSState } from '@struktoai/mirage-core/vfs/gslides/gslides'
export {
  normalizeGSlidesConfig,
  redactGSlidesConfig,
  type GSlidesConfig,
  type GSlidesConfigRedacted,
} from '@struktoai/mirage-core/vfs/gslides/config'
export { GDriveVFS, type GDriveVFSState } from '@struktoai/mirage-core/vfs/gdrive/gdrive'
export {
  normalizeGDriveConfig,
  redactGDriveConfig,
  type GDriveConfig,
  type GDriveConfigRedacted,
} from '@struktoai/mirage-core/vfs/gdrive/config'
export { DropboxVFS, type DropboxVFSState } from '@struktoai/mirage-core/vfs/dropbox/dropbox'
export {
  normalizeDropboxConfig,
  redactDropboxConfig,
  type DropboxConfig,
  type DropboxConfigRedacted,
} from '@struktoai/mirage-core/vfs/dropbox/config'
export { BoxVFS, type BoxVFSState } from '@struktoai/mirage-core/vfs/box/box'
export {
  normalizeBoxConfig,
  redactBoxConfig,
  type BoxConfig,
  type BoxConfigRedacted,
} from '@struktoai/mirage-core/vfs/box/config'
export { GmailVFS, type GmailVFSState } from '@struktoai/mirage-core/vfs/gmail/gmail'
export {
  normalizeGmailConfig,
  redactGmailConfig,
  type GmailConfig,
  type GmailConfigRedacted,
} from '@struktoai/mirage-core/vfs/gmail/config'
export { GCalVFS, type GCalVFSState } from '@struktoai/mirage-core/vfs/gcal/gcal'
export {
  normalizeGCalConfig,
  redactGCalConfig,
  type GCalConfig,
  type GCalConfigRedacted,
} from '@struktoai/mirage-core/vfs/gcal/config'
export { RedisVFS, type RedisVFSOptions, type RedisVFSState } from './vfs/redis/redis.ts'
export { UpstashRedisStore, type UpstashRedisStoreOptions } from './vfs/redis/store.ts'
export { PROMPT as REDIS_PROMPT } from '@struktoai/mirage-core/vfs/redis/prompt'
export { REDIS_COMMANDS } from '@struktoai/mirage-core/commands/builtin/redis/index'
export { RedisAccessor } from '@struktoai/mirage-core/accessor/redis'
export {
  buildVfs,
  knownVfsNames,
  register as registerVfsFactory,
  type VFSFactory,
} from './vfs/registry.ts'

// The authoring surface: what a host reaches for to bring its own
// VFS, CLI, policy or runtime, and the types the Workspace's own
// signatures hand back. Core's barrel is the front door for a program
// that mounts and runs; these are the doors behind it, re-exported by
// module so a consumer of this package needs no second dependency on
// core to reach them (`@struktoai/mirage-core/<path>` works too).
export { BaseVFS } from '@struktoai/mirage-core/vfs/base'
export { makeGenericCommands } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
export { FlagView } from '@struktoai/mirage-core/commands/spec/flag_view'
export { type FlagValue, UsageStyle } from '@struktoai/mirage-core/commands/spec/types'
export type { CLIDoors } from '@struktoai/mirage-core/commands/cli/types'
export { UsageError } from '@struktoai/mirage-core/commands/errors'
export { PolicyDenied, PolicyError } from '@struktoai/mirage-core/policy/errors'
export {
  type Ask,
  type AskHandler,
  type Decision,
  Decisions,
  type CommandExplanation,
  type Deny,
  type Explanation,
  Outcome,
  Scope,
  type SessionContext,
  type ShellExplanation,
  type ShellNode,
  type ShellOperand,
  type VfsExplanation,
} from '@struktoai/mirage-core/policy/index'
export { LanguageRuntime } from '@struktoai/mirage-core/runtime/language'
export { RemoteSandbox } from '@struktoai/mirage-core/runtime/sandbox/base'
export type { E2BConfig } from '@struktoai/mirage-core/runtime/sandbox/e2b/config'
export type { HomeConfig, RuntimeConfig } from '@struktoai/mirage-core/runtime/config'
export { knownRuntimes, registerRuntime } from '@struktoai/mirage-core/runtime/table'
export { type MountResolver, PrefixResolver } from '@struktoai/mirage-core/runtime/resolver'
export { RuntimeVFS } from '@struktoai/mirage-core/runtime/vfs'
export { CrossMountError } from '@struktoai/mirage-core/runtime/errors'
export type { RunArgs, RuntimeReach } from '@struktoai/mirage-core/runtime/types'
export {
  DenyResult,
  type RouteContext,
  type RoutePolicy,
  RouteResult,
} from '@struktoai/mirage-core/runtime/routing/types'
export {
  type ExecuteOptions,
  ExecuteResult,
  type WorkspaceOptions,
} from '@struktoai/mirage-core/workspace/workspace/types'
export { Ops } from '@struktoai/mirage-core/ops/ops'
export { Namespace } from '@struktoai/mirage-core/workspace/mount/namespace/namespace'

export { WandbVFS } from '@struktoai/mirage-core/vfs/wandb/wandb'
export { normalizeWandbConfig, type WandbConfig } from '@struktoai/mirage-core/core/wandb/config'
