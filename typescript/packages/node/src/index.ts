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
export { RedisAccessor } from '@struktoai/mirage-core/accessor/redis'
export { MountCore, type MountCoreOptions } from '@struktoai/mirage-core/mount/core'
export { isMacosMetadata } from '@struktoai/mirage-core/mount/platform/macos'
export type { MountAttrs } from '@struktoai/mirage-core/mount/types'
export { SessionProfile } from '@struktoai/mirage-core/policy/profile'
export { Mount, type MountSpecOptions } from '@struktoai/mirage-core/workspace/mount/spec'
export { GridFSAccessor } from './accessor/gridfs.ts'
export { RedisFileCacheStore, type RedisFileCacheOptions } from './cache/file/redis.ts'
export {
  checkMountpoint,
  checkPlatform,
  checkSizes,
  FSKIT_MOUNT_ROOT,
  prepareBackend,
  requireKernelBackend,
  resolveBackend,
  unsizedMounts,
} from './fuse/backend.ts'
export { MirageFS, type MirageFSOptions } from './fuse/fs.ts'
export {
  mount as fuseMount,
  type FuseHandle,
  type MountOptions as FuseMountOptions,
} from './fuse/mount.ts'
export { classifyErrno, classifyError } from './mount/errors.ts'
export { DiskObserverStore } from './observe/disk_store.ts'
export { patchNodeFs } from './runtime/js/host/fs.ts'
export { RedisJobStore, type RedisJobStoreOptions } from './shell/job_table/redis.ts'
export { DatabricksVolumeVFS } from './vfs/databricks_volume/databricks_volume.ts'
export { DiskVFS, type DiskVFSOptions, type DiskVFSState } from './vfs/disk/disk.ts'
export { normalizeGridFSConfig, type GridFSConfig } from './vfs/gridfs/config.ts'
export { GridFSVFS } from './vfs/gridfs/gridfs.ts'
export { RedisVFS, type RedisVFSOptions, type RedisVFSState } from './vfs/redis/redis.ts'
export { RedisStore, type RedisStoreOptions } from './vfs/redis/store.ts'
export { S3VFS } from './vfs/s3/s3.ts'
export { TiDBFilesystemVFS } from './vfs/tidb_filesystem/tidb_filesystem.ts'
export { Workspace, type NodeWorkspaceOptions } from './workspace.ts'
export { FuseManager } from './workspace/fuse.ts'
export { DiskNamespaceStore } from './workspace/mount/namespace/disk.ts'
export {
  RedisNamespaceStore,
  type RedisNamespaceStoreOptions,
} from './workspace/mount/namespace/redis.ts'
export { DiskRecordClient } from './workspace/record/disk.ts'
export {
  DEFAULT_STATE_ROOT,
  DiskWorkspaceStateStore,
  DOT_IDS,
  type DiskWorkspaceStateStoreOptions,
} from './workspace/store/disk.ts'
export {
  RedisWorkspaceStateStore,
  type RedisWorkspaceStateStoreOptions,
} from './workspace/store/redis.ts'

export type { LinearConfig } from '@struktoai/mirage-core/core/linear/config'
export type { NotionConfig } from '@struktoai/mirage-core/core/notion/config'
export type { TrelloConfig } from '@struktoai/mirage-core/core/trello/config'
export type { DiscordConfig } from '@struktoai/mirage-core/vfs/discord/config'
export { LinearVFS } from '@struktoai/mirage-core/vfs/linear/linear'
export type { SlackConfig } from '@struktoai/mirage-core/vfs/slack/config'
export { TrelloVFS } from '@struktoai/mirage-core/vfs/trello/trello'
export { HfBucketsAccessor } from './accessor/hf_buckets.ts'
export { NextcloudAccessor } from './accessor/nextcloud.ts'
export { SSHAccessor } from './accessor/ssh.ts'
export { NextcloudEventHook } from './core/nextcloud/events.ts'
export { AliyunVFS } from './vfs/aliyun/aliyun.ts'
export { type AliyunConfig } from './vfs/aliyun/config.ts'
export { BackblazeVFS } from './vfs/backblaze/backblaze.ts'
export { type BackblazeConfig } from './vfs/backblaze/config.ts'
export { CephVFS } from './vfs/ceph/ceph.ts'
export type { CephConfig } from './vfs/ceph/config.ts'
export { type DigitalOceanConfig } from './vfs/digitalocean/config.ts'
export { DigitalOceanVFS } from './vfs/digitalocean/digitalocean.ts'
export { DiscordVFS } from './vfs/discord/discord.ts'
export { GCS_ENDPOINT, type GCSConfig } from './vfs/gcs/config.ts'
export { GCSVFS } from './vfs/gcs/gcs.ts'
export {
  assertHfRepoId,
  HF_ENDPOINT,
  normalizeHfBucketsConfig,
  normalizeHfRepoConfig,
  redactHfBucketsConfig,
  redactHfRepoConfig,
  type HfBucketsConfig,
  type HfRepoConfig,
} from './vfs/hf_buckets/config.ts'
export { HfBucketsVFS } from './vfs/hf_buckets/hf_buckets.ts'
export type { HfDatasetsConfig } from './vfs/hf_datasets/config.ts'
export { HfDatasetsVFS } from './vfs/hf_datasets/hf_datasets.ts'
export type { HfModelsConfig } from './vfs/hf_models/config.ts'
export { HfModelsVFS } from './vfs/hf_models/hf_models.ts'
export type { HfSpacesConfig } from './vfs/hf_spaces/config.ts'
export { HfSpacesVFS } from './vfs/hf_spaces/hf_spaces.ts'
export { LanceDBVFS, type LanceDBVFSOptions } from './vfs/lancedb/lancedb.ts'
export { LanceDBStore } from './vfs/lancedb/store.ts'
export type { MinIOConfig } from './vfs/minio/config.ts'
export { MinIOVFS } from './vfs/minio/minio.ts'
export { MongoDBVFS, type MongoDBVFSOptions } from './vfs/mongodb/mongodb.ts'
export { MongoDBStore } from './vfs/mongodb/store.ts'
export type { NextcloudConfig } from './vfs/nextcloud/config.ts'
export { NextcloudVFS } from './vfs/nextcloud/nextcloud.ts'
export { NotionVFS } from './vfs/notion/notion.ts'
export type { OCIConfig } from './vfs/oci/config.ts'
export { OCIVFS } from './vfs/oci/oci.ts'
export { PostgresVFS, type PostgresVFSOptions } from './vfs/postgres/postgres.ts'
export { PostgresStore } from './vfs/postgres/store.ts'
export { type QingStorConfig } from './vfs/qingstor/config.ts'
export { QingStorVFS } from './vfs/qingstor/qingstor.ts'
export type { R2Config } from './vfs/r2/config.ts'
export { R2VFS } from './vfs/r2/r2.ts'
export type { S3Config } from './vfs/s3/config.ts'
export { type ScalewayConfig } from './vfs/scaleway/config.ts'
export { ScalewayVFS } from './vfs/scaleway/scaleway.ts'
export type { SeaweedFSConfig } from './vfs/seaweedfs/config.ts'
export { SeaweedFSVFS } from './vfs/seaweedfs/seaweedfs.ts'
export { SlackVFS } from './vfs/slack/slack.ts'
export type { SSHConfig } from './vfs/ssh/config.ts'
export { SSHVFS } from './vfs/ssh/ssh.ts'
export { type SupabaseConfig } from './vfs/supabase/config.ts'
export { SupabaseVFS } from './vfs/supabase/supabase.ts'
export { type TencentConfig } from './vfs/tencent/config.ts'
export { TencentVFS } from './vfs/tencent/tencent.ts'
export { type WasabiConfig } from './vfs/wasabi/config.ts'
export { WasabiVFS } from './vfs/wasabi/wasabi.ts'
// Named rather than left to the `export *` above: the three VFS classes come
// through it, but core's entry point carries no config type of theirs, so
// dropping these lines would take them out of this package's API too.
export type { OneDriveConfig } from '@struktoai/mirage-core/accessor/onedrive'
export type { SharePointConfig } from '@struktoai/mirage-core/accessor/sharepoint'
export type { AirtableConfig } from '@struktoai/mirage-core/core/airtable/config'
export type { GitHubConfig } from '@struktoai/mirage-core/core/github/config'
export { MontyRuntime } from '@struktoai/mirage-core/runtime/python/monty/runtime'
export type { E2BConfig } from '@struktoai/mirage-core/runtime/sandbox/e2b/config'
export { E2BRuntime } from '@struktoai/mirage-core/runtime/sandbox/e2b/runtime'
export { BoxVFS } from '@struktoai/mirage-core/vfs/box/box'
export type { BoxConfig } from '@struktoai/mirage-core/vfs/box/config'
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
export type { Mem0Config } from '@struktoai/mirage-core/vfs/mem0/config'
export { EmailAccessor } from './accessor/email.ts'
export { HF } from './commands/cli/builtin/hf/index.ts'
export { HIMALAYA } from './commands/cli/builtin/himalaya/index.ts'
export {
  absolutizeScripts,
  checkWorkspaceConfig,
  checkWorkspaceConfigFile,
  configToWorkspaceArgs,
  interpolateEnv,
  loadPolicyFile,
  loadProfilePolicy,
  loadWorkspaceConfig,
  loadWorkspaceConfigFile,
  type MountBlock,
  type WorkspaceConfigRaw,
} from './config.ts'
export { LocalRuntime } from './runtime/python/local/runtime.ts'
export type { AppleContainerConfig } from './runtime/sandbox/apple_container/config.ts'
export { AppleContainerRuntime } from './runtime/sandbox/apple_container/runtime.ts'
export type { DaytonaConfig } from './runtime/sandbox/daytona/config.ts'
export { DaytonaRuntime } from './runtime/sandbox/daytona/runtime.ts'
export type { DockerConfig } from './runtime/sandbox/docker/config.ts'
export { DockerRuntime } from './runtime/sandbox/docker/runtime.ts'
export type { MicrosandboxConfig } from './runtime/sandbox/microsandbox/config.ts'
export { MicrosandboxRuntime } from './runtime/sandbox/microsandbox/runtime.ts'
export type { SandlockConfig } from './runtime/sandbox/sandlock/config.ts'
export { SandlockRuntime } from './runtime/sandbox/sandlock/runtime.ts'
export type { SmolvmConfig } from './runtime/sandbox/smolvm/config.ts'
export { SmolvmRuntime } from './runtime/sandbox/smolvm/runtime.ts'
export type { SSHRuntimeConfig } from './runtime/sandbox/ssh/config.ts'
export { SSHRuntime } from './runtime/sandbox/ssh/runtime.ts'
export { isModulePath, loadAttr, MODULE_SUFFIXES, splitRef } from './utils/loader.ts'
export type { DropboxConfig } from './vfs/dropbox/config.ts'
export { EmailVFS } from './vfs/email/email.ts'
export { buildEmailConfig, type EmailConfig, type EmailConfigInput } from './vfs/email/index.ts'
export { JaegerVFS } from './vfs/jaeger/jaeger.ts'
export { buildVfs, knownVfsNames, registerVfs, type VFSFactory } from './vfs/registry.ts'

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
