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
// The Airtable, Mem0, OneDrive and SharePoint config types are named below
// rather than left to the `export *` above: their VFS classes come through
// it, but core's entry point carries no config type of theirs, so dropping
// these lines would take them out of this package's API too.
export type { OneDriveConfig } from '@struktoai/mirage-core/accessor/onedrive'
export { RedisAccessor } from '@struktoai/mirage-core/accessor/redis'
export type { SharePointConfig } from '@struktoai/mirage-core/accessor/sharepoint'
export type { AirtableConfig } from '@struktoai/mirage-core/core/airtable/config'
export type { GitHubConfig } from '@struktoai/mirage-core/core/github/config'
export type { LinearConfig } from '@struktoai/mirage-core/core/linear/config'
export type { TrelloConfig } from '@struktoai/mirage-core/core/trello/config'
export { BoxVFS } from '@struktoai/mirage-core/vfs/box/box'
export type { BoxConfig } from '@struktoai/mirage-core/vfs/box/config'
export type { DropboxConfig } from '@struktoai/mirage-core/vfs/dropbox/config'
export { DropboxVFS } from '@struktoai/mirage-core/vfs/dropbox/dropbox'
export type { GCalConfig } from '@struktoai/mirage-core/vfs/gcal/config'
export { GCalVFS } from '@struktoai/mirage-core/vfs/gcal/gcal'
export type { GDocsConfig } from '@struktoai/mirage-core/vfs/gdocs/config'
export { GDocsVFS } from '@struktoai/mirage-core/vfs/gdocs/gdocs'
export type { GoogleDriveConfig } from '@struktoai/mirage-core/vfs/gdrive/config'
export { GoogleDriveVFS } from '@struktoai/mirage-core/vfs/gdrive/gdrive'
export { GitHubVFS, type GitHubVFSState } from '@struktoai/mirage-core/vfs/github/github'
export type { GmailConfig } from '@struktoai/mirage-core/vfs/gmail/config'
export { GmailVFS } from '@struktoai/mirage-core/vfs/gmail/gmail'
export type { GSheetsConfig } from '@struktoai/mirage-core/vfs/gsheets/config'
export { GSheetsVFS } from '@struktoai/mirage-core/vfs/gsheets/gsheets'
export type { GSlidesConfig } from '@struktoai/mirage-core/vfs/gslides/config'
export { GSlidesVFS } from '@struktoai/mirage-core/vfs/gslides/gslides'
export type { LangfuseConfig } from '@struktoai/mirage-core/vfs/langfuse/config'
export { LangfuseVFS } from '@struktoai/mirage-core/vfs/langfuse/langfuse'
export { LinearVFS } from '@struktoai/mirage-core/vfs/linear/linear'
export type { Mem0Config } from '@struktoai/mirage-core/vfs/mem0/config'
export { TrelloVFS } from '@struktoai/mirage-core/vfs/trello/trello'
export { OPFSAccessor } from './accessor/opfs.ts'
export { AliyunVFS } from './vfs/aliyun/aliyun.ts'
export { AliyunConfig } from './vfs/aliyun/config.ts'
export { BackblazeVFS } from './vfs/backblaze/backblaze.ts'
export { BackblazeConfig } from './vfs/backblaze/config.ts'
export { CephVFS } from './vfs/ceph/ceph.ts'
export { CephConfig } from './vfs/ceph/config.ts'
export { DigitalOceanConfig } from './vfs/digitalocean/config.ts'
export { DigitalOceanVFS } from './vfs/digitalocean/digitalocean.ts'
export type { DiscordConfig } from './vfs/discord/config.ts'
export { DiscordVFS } from './vfs/discord/discord.ts'
export { GCSConfig } from './vfs/gcs/config.ts'
export { GCSVFS } from './vfs/gcs/gcs.ts'
export { MinIOConfig } from './vfs/minio/config.ts'
export { MinIOVFS } from './vfs/minio/minio.ts'
export { HttpMongoDriver, type HttpMongoDriverOptions } from './vfs/mongodb/http_driver.ts'
export { MongoDBVFS, type MongoDBVFSOptions } from './vfs/mongodb/mongodb.ts'
export type { NotionConfig } from './vfs/notion/config.ts'
export { NotionVFS } from './vfs/notion/notion.ts'
export { OCIConfig } from './vfs/oci/config.ts'
export { OCIVFS } from './vfs/oci/oci.ts'
export { OPFSVFS, type OPFSVFSOptions, type OPFSVFSState } from './vfs/opfs/opfs.ts'
export { NeonPgDriver } from './vfs/postgres/neon_driver.ts'
export { PostgresVFS, type PostgresVFSOptions } from './vfs/postgres/postgres.ts'
export { QingStorConfig } from './vfs/qingstor/config.ts'
export { QingStorVFS } from './vfs/qingstor/qingstor.ts'
export { R2Config } from './vfs/r2/config.ts'
export { R2VFS } from './vfs/r2/r2.ts'
export { RedisVFS, type RedisVFSOptions, type RedisVFSState } from './vfs/redis/redis.ts'
export { UpstashRedisStore, type UpstashRedisStoreOptions } from './vfs/redis/store.ts'
export { buildVfs, knownVfsNames, registerVfs, type VFSFactory } from './vfs/registry.ts'
export type {
  S3BrowserOperation,
  S3BrowserPresignedUrlProvider,
  S3BrowserSignOptions,
  S3Config,
} from './vfs/s3/config.ts'
export { S3VFS } from './vfs/s3/s3.ts'
export { ScalewayConfig } from './vfs/scaleway/config.ts'
export { ScalewayVFS } from './vfs/scaleway/scaleway.ts'
export { SeaweedFSConfig } from './vfs/seaweedfs/config.ts'
export { SeaweedFSVFS } from './vfs/seaweedfs/seaweedfs.ts'
export type { SlackConfig } from './vfs/slack/config.ts'
export { SlackVFS } from './vfs/slack/slack.ts'
export { SupabaseConfig } from './vfs/supabase/config.ts'
export { SupabaseVFS } from './vfs/supabase/supabase.ts'
export { TencentConfig } from './vfs/tencent/config.ts'
export { TencentVFS } from './vfs/tencent/tencent.ts'
export { WasabiConfig } from './vfs/wasabi/config.ts'
export { WasabiVFS } from './vfs/wasabi/wasabi.ts'
export { Workspace } from './workspace.ts'

// The authoring surface: what a host reaches for to bring its own
// VFS, CLI, policy or runtime, and the types the Workspace's own
// signatures hand back. Core's barrel is the entry point for a program
// that mounts and runs; these are the entry points behind it, re-exported by
// module so a consumer of this package needs no second dependency on
// core to reach them (`@struktoai/mirage-core/<path>` works too).
export { generic } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
export type { Context } from '@struktoai/mirage-core/commands/config'
export { UsageError } from '@struktoai/mirage-core/commands/errors'
export { FlagView } from '@struktoai/mirage-core/commands/spec/flag_view'
export { UsageStyle, type FlagValue } from '@struktoai/mirage-core/commands/spec/types'
export { PolicyDenied, PolicyError } from '@struktoai/mirage-core/policy/errors'
export {
  CommandWord,
  Decisions,
  Outcome,
  Scope,
  type Ask,
  type AskHandler,
  type CommandExplanation,
  type Decision,
  type Deny,
  type Explanation,
  type RouteContext,
  type SessionContext,
  type ShellExplanation,
  type ShellNode,
  type VfsExplanation,
} from '@struktoai/mirage-core/policy/index'
export type { HomeConfig, RuntimeConfig } from '@struktoai/mirage-core/runtime/config'
export { RuntimeFiles } from '@struktoai/mirage-core/runtime/files'
export { LanguageRuntime } from '@struktoai/mirage-core/runtime/language'
export { PrefixResolver, type MountResolver } from '@struktoai/mirage-core/runtime/resolver'
export type { RouteRule } from '@struktoai/mirage-core/runtime/routing/types'
export { RemoteSandbox } from '@struktoai/mirage-core/runtime/sandbox/base'
export type { E2BConfig } from '@struktoai/mirage-core/runtime/sandbox/e2b/config'
export { knownRuntimes, registerRuntime } from '@struktoai/mirage-core/runtime/table'
export type { ExecutionKind, Program, RuntimeReach } from '@struktoai/mirage-core/runtime/types'
export { BaseVFS } from '@struktoai/mirage-core/vfs/base'
export { Files, WorkspaceFiles } from '@struktoai/mirage-core/workspace/files'
export { Namespace } from '@struktoai/mirage-core/workspace/mount/namespace/namespace'
export {
  ExecuteResult,
  type ExecuteOptions,
  type WorkspaceOptions,
} from '@struktoai/mirage-core/workspace/workspace/types'

export type { WandbConfig } from '@struktoai/mirage-core/core/wandb/config'
export { WandbVFS } from '@struktoai/mirage-core/vfs/wandb/wandb'
