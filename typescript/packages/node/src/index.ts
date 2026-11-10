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
export { RedisExecutionStore, type RedisExecutionStoreOptions } from './execution/redis.ts'
export { DatabricksVolumeVFS } from '@struktoai/mirage-core/vfs/direct/databricks_volume'
export { DiskVFS, type DiskVFSOptions, type DiskVFSState } from './vfs/disk/disk.ts'
export { normalizeGridFSConfig, type GridFSConfig } from './vfs/gridfs/config.ts'
export { GridFSVFS } from './vfs/gridfs/gridfs.ts'
export { RedisVFS, type RedisVFSOptions, type RedisVFSState } from './vfs/redis/redis.ts'
export { RedisStore, type RedisStoreOptions } from './vfs/redis/store.ts'
export { SqliteDriver } from './vfs/sql/driver.ts'
export { PostgresSqlDriver } from './vfs/sql/postgres.ts'
export { SqlVFS, type SqlVFSOptions } from './vfs/sql/sql.ts'
export { S3VFS } from './vfs/s3/s3.ts'
export { TiDBFilesystemVFS } from '@struktoai/mirage-core/vfs/direct/tidb_filesystem'
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
export { SqlRecordClient } from '@struktoai/mirage-core/workspace/record/sql'
export {
  SqlWorkspaceStateStore,
  type SqlWorkspaceStateStoreOptions,
} from '@struktoai/mirage-core/workspace/store/sql'

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
export { AliyunVFS } from '@struktoai/mirage-core/vfs/aliyun/aliyun'
export { AliyunConfig } from '@struktoai/mirage-core/vfs/aliyun/config'
export { BackblazeVFS } from '@struktoai/mirage-core/vfs/backblaze/backblaze'
export { BackblazeConfig } from '@struktoai/mirage-core/vfs/backblaze/config'
export { CephVFS } from '@struktoai/mirage-core/vfs/ceph/ceph'
export { CephConfig } from '@struktoai/mirage-core/vfs/ceph/config'
export { DigitalOceanConfig } from '@struktoai/mirage-core/vfs/digitalocean/config'
export { DigitalOceanVFS } from '@struktoai/mirage-core/vfs/digitalocean/digitalocean'
export { DiscordVFS } from '@struktoai/mirage-core/vfs/direct/discord'
export { GCS_ENDPOINT, GCSConfig } from '@struktoai/mirage-core/vfs/gcs/config'
export { GCSVFS } from '@struktoai/mirage-core/vfs/gcs/gcs'
export {
  assertHfRepoId,
  HF_ENDPOINT,
  normalizeHfBucketsConfig,
  normalizeHfRepoConfig,
  redactHfBucketsConfig,
  redactHfRepoConfig,
  type HfBucketsConfig,
  type HfRepoConfig,
} from '@struktoai/mirage-core/vfs/hf_buckets/config'
export { HfBucketsVFS } from './vfs/hf_buckets/hf_buckets.ts'
export type { HfDatasetsConfig } from '@struktoai/mirage-core/vfs/hf_datasets/config'
export { HfDatasetsVFS } from '@struktoai/mirage-core/vfs/hf_datasets/hf_datasets'
export type { HfModelsConfig } from '@struktoai/mirage-core/vfs/hf_models/config'
export { HfModelsVFS } from '@struktoai/mirage-core/vfs/hf_models/hf_models'
export type { HfSpacesConfig } from '@struktoai/mirage-core/vfs/hf_spaces/config'
export { HfSpacesVFS } from '@struktoai/mirage-core/vfs/hf_spaces/hf_spaces'
export { LanceDBVFS, type LanceDBVFSOptions } from './vfs/lancedb/lancedb.ts'
export { LanceDBStore } from './vfs/lancedb/store.ts'
export { MinIOConfig } from '@struktoai/mirage-core/vfs/minio/config'
export { MinIOVFS } from '@struktoai/mirage-core/vfs/minio/minio'
export { MongoDBVFS, type MongoDBVFSOptions } from './vfs/mongodb/mongodb.ts'
export { MongoDBStore } from './vfs/mongodb/store.ts'
export type { NextcloudConfig } from './vfs/nextcloud/config.ts'
export { NextcloudVFS } from './vfs/nextcloud/nextcloud.ts'
export { NotionVFS } from '@struktoai/mirage-core/vfs/direct/notion'
export { OCIConfig } from '@struktoai/mirage-core/vfs/oci/config'
export { OCIVFS } from '@struktoai/mirage-core/vfs/oci/oci'
export { PostgresVFS, type PostgresVFSOptions } from '@struktoai/mirage-core/vfs/direct/postgres'
export { PostgresStore } from '@struktoai/mirage-core/vfs/postgres/store'
export { QingStorConfig } from '@struktoai/mirage-core/vfs/qingstor/config'
export { QingStorVFS } from '@struktoai/mirage-core/vfs/qingstor/qingstor'
export { R2Config } from '@struktoai/mirage-core/vfs/r2/config'
export { R2VFS } from '@struktoai/mirage-core/vfs/r2/r2'
export type { S3Config } from '@struktoai/mirage-core/vfs/direct/s3'
export { ScalewayConfig } from '@struktoai/mirage-core/vfs/scaleway/config'
export { ScalewayVFS } from '@struktoai/mirage-core/vfs/scaleway/scaleway'
export { SeaweedFSConfig } from '@struktoai/mirage-core/vfs/seaweedfs/config'
export { SeaweedFSVFS } from '@struktoai/mirage-core/vfs/seaweedfs/seaweedfs'
export { SlackVFS } from '@struktoai/mirage-core/vfs/direct/slack'
export type { SSHConfig } from './vfs/ssh/config.ts'
export { SSHVFS } from './vfs/ssh/ssh.ts'
export { SupabaseConfig } from '@struktoai/mirage-core/vfs/supabase/config'
export { SupabaseVFS } from '@struktoai/mirage-core/vfs/supabase/supabase'
export { TencentConfig } from '@struktoai/mirage-core/vfs/tencent/config'
export { TencentVFS } from '@struktoai/mirage-core/vfs/tencent/tencent'
export { WasabiConfig } from '@struktoai/mirage-core/vfs/wasabi/config'
export { WasabiVFS } from '@struktoai/mirage-core/vfs/wasabi/wasabi'
// The Airtable, Mem0, OneDrive and SharePoint config types are named below
// rather than left to the `export *` above: their VFS classes come through
// it, but core's entry point carries no config type of theirs, so dropping
// these lines would take them out of this package's API too.
export type { OneDriveConfig } from '@struktoai/mirage-core/accessor/onedrive'
export type { SharePointConfig } from '@struktoai/mirage-core/accessor/sharepoint'
export type { AirtableConfig } from '@struktoai/mirage-core/core/airtable/config'
export type { GitHubConfig } from '@struktoai/mirage-core/core/github/config'
export { MontyRuntime } from '@struktoai/mirage-core/runtime/python/monty/runtime'
export { RemoteRuntime } from '@struktoai/mirage-core/runtime/machine/runtime'
export type { E2BConfig } from '@struktoai/mirage-core/machine/e2b/config'
export { E2BMachine } from '@struktoai/mirage-core/machine/e2b/handle'
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
export { EmailAccessor } from '@struktoai/mirage-core/accessor/email'
export { HF } from '@struktoai/mirage-core/commands/cli/builtin/hf/index'
export { HIMALAYA } from '@struktoai/mirage-core/commands/cli/builtin/himalaya/index'
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
export type { AppleContainerConfig } from './machine/apple_container/config.ts'
export { AppleContainerMachine } from './machine/apple_container/handle.ts'
export type { DaytonaConfig } from './machine/daytona/config.ts'
export { DaytonaMachine } from './machine/daytona/handle.ts'
export type { DockerConfig } from './machine/docker/config.ts'
export { DockerMachine } from './machine/docker/handle.ts'
export type { KubernetesConfig } from './machine/kubernetes/config.ts'
export { KubernetesMachine } from './machine/kubernetes/handle.ts'
export type { MicrosandboxConfig } from './machine/microsandbox/config.ts'
export { MicrosandboxMachine } from './machine/microsandbox/handle.ts'
export type { SandlockConfig } from './runtime/sandlock/config.ts'
export { SandlockRuntime } from './runtime/sandlock/runtime.ts'
export type { SmolvmConfig } from './machine/smolvm/config.ts'
export { SmolvmMachine } from './machine/smolvm/handle.ts'
export type { SSHMachineConfig } from './machine/ssh/config.ts'
export { SSHMachine } from './machine/ssh/handle.ts'
export { isModulePath, loadAttr, MODULE_SUFFIXES, splitRef } from './utils/loader.ts'
export type { DropboxConfig } from '@struktoai/mirage-core/vfs/direct/dropbox'
export { EmailVFS } from '@struktoai/mirage-core/vfs/email/email'
export {
  buildEmailConfig,
  type EmailConfig,
  type EmailConfigInput,
} from '@struktoai/mirage-core/vfs/email/index'
export { JaegerVFS } from '@struktoai/mirage-core/vfs/direct/jaeger'
export { buildVfs, knownVfsNames, registerVfs, type VFSFactory } from './vfs/registry.ts'

// The authoring surface: what a host reaches for to bring its own
// VFS, CLI, policy or runtime, and the types the Workspace's own
// signatures hand back. Core's barrel is the entry point for a program
// that mounts and runs; these are the entry points behind it, re-exported by
// module so a consumer of this package needs no second dependency on
// core to reach them (`@struktoai/mirage-core/<path>` works too).
export { generic } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
export type { Context } from '@struktoai/mirage-core/commands/config'
export { MCPToolsError } from '@struktoai/mirage-core/commands/cli/mcp/errors'
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
  type ShellExplanation,
  type ShellNode,
  type VfsExplanation,
} from '@struktoai/mirage-core/policy/index'
export type { HomeConfig, RuntimeConfig } from '@struktoai/mirage-core/runtime/config'
export { RuntimeFiles } from '@struktoai/mirage-core/runtime/files'
export { LanguageRuntime } from '@struktoai/mirage-core/runtime/language'
export { PrefixResolver, type MountResolver } from '@struktoai/mirage-core/runtime/resolver'
export type { RouteRule } from '@struktoai/mirage-core/runtime/routing/types'
export { MachineHandle } from '@struktoai/mirage-core/machine/handle'
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
