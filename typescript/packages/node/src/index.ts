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
export { Workspace, type NodeWorkspaceOptions } from './workspace.ts'
export { Mount, type MountSpecOptions } from '@struktoai/mirage-core/workspace/mount/spec'
export { DiskVFS, type DiskVFSOptions, type DiskVFSState } from './vfs/disk/disk.ts'
export { DISK_PROMPT } from './vfs/disk/prompt.ts'
export { DISK_OPS } from './ops/disk/index.ts'
export { DiskObserverStore } from './observe/disk_store.ts'
export { RedisObserverStore, type RedisObserverStoreOptions } from './observe/redis_store.ts'
export { RedisConsoleStore, type RedisConsoleStoreOptions } from './shell/console/redis/index.ts'
export { DiskNamespaceStore } from './workspace/namespace/disk.ts'
export {
  RedisNamespaceStore,
  type RedisNamespaceStoreOptions,
} from './workspace/namespace/redis.ts'
export { DiskRecordClient } from './workspace/record/disk.ts'
export { parseSessionProfile, type SessionProfile } from '@struktoai/mirage-core/policy/profile'
export { DiskSessionStore } from './workspace/session/disk.ts'
export { RedisSessionStore, type RedisSessionStoreOptions } from './workspace/session/redis.ts'
export {
  DEFAULT_STATE_ROOT,
  DiskWorkspaceStateStore,
  type DiskWorkspaceStateStoreOptions,
} from './workspace/store/disk.ts'
export {
  RedisWorkspaceStateStore,
  type RedisWorkspaceStateStoreOptions,
} from './workspace/store/redis.ts'
export { patchNodeFs } from './fs_monkey.ts'
export { RedisVFS, type RedisVFSOptions, type RedisVFSState } from './vfs/redis/redis.ts'
export { REDIS_PROMPT } from '@struktoai/mirage-core/vfs/redis/prompt'
export { RedisStore, type RedisStoreOptions } from './vfs/redis/store.ts'
export { RedisAccessor } from '@struktoai/mirage-core/accessor/redis'
export { REDIS_OPS } from '@struktoai/mirage-core/ops/redis/index'
export {
  fileReadProvision,
  headTailProvision,
  metadataProvision,
  type RedisResourceLike,
} from '@struktoai/mirage-core/commands/builtin/redis/_provision'
export { RedisFileCacheStore, type RedisFileCacheOptions } from './cache/file/redis.ts'
export { FuseManager } from './workspace/fuse.ts'
export { MirageFS, type MirageFSOptions, type FuseAttr } from './fuse/fs.ts'
export { MountCore, type MountCoreOptions } from './fuse/core.ts'
export { classifyErrno, classifyError } from './fuse/errors.ts'
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
export {
  mount as fuseMount,
  mountBackground as fuseMountBackground,
  type FuseHandle,
  type MountOptions as FuseMountOptions,
} from './fuse/mount.ts'
export { isMacosMetadata } from './fuse/platform/macos.ts'
export { S3VFS, type S3VFSState } from './vfs/s3/s3.ts'
export { S3_COMMANDS } from '@struktoai/mirage-core/commands/builtin/s3/index'
export { GridFSVFS, type GridFSVFSState } from './vfs/gridfs/gridfs.ts'
export {
  normalizeGridFSConfig,
  type GridFSConfig,
  type GridFSConfigRedacted,
} from './vfs/gridfs/config.ts'
export { GridFSAccessor } from './accessor/gridfs.ts'
export {
  DatabricksVolumeVFS,
  type DatabricksVolumeVFSState,
} from './vfs/databricks_volume/databricks_volume.ts'
export {
  loadDatabricksProfile,
  parseDatabricksCfg,
  type DatabricksProfile,
} from './vfs/databricks_volume/profile.ts'
export {
  normalizeS3Config,
  redactConfig as redactS3Config,
  type S3Config,
  type S3ConfigRedacted,
} from './vfs/s3/config.ts'
export { GCSVFS, type GCSVFSState } from './vfs/gcs/gcs.ts'
export {
  GCS_ENDPOINT,
  redactGcsConfig,
  type GCSConfig,
  type GCSConfigRedacted,
} from './vfs/gcs/config.ts'
export { GCS_PROMPT } from './vfs/gcs/prompt.ts'
export { OCIVFS, type OCIVFSState } from './vfs/oci/oci.ts'
export { redactOciConfig, type OCIConfig, type OCIConfigRedacted } from './vfs/oci/config.ts'
export { OCI_PROMPT } from './vfs/oci/prompt.ts'
export { R2VFS, type R2VFSState } from './vfs/r2/r2.ts'
export { redactR2Config, type R2Config, type R2ConfigRedacted } from './vfs/r2/config.ts'
export { R2_PROMPT } from './vfs/r2/prompt.ts'
export { SupabaseVFS, type SupabaseVFSState } from './vfs/supabase/supabase.ts'
export {
  redactSupabaseConfig,
  resolvedSupabaseEndpoint,
  type SupabaseConfig,
  type SupabaseConfigRedacted,
} from './vfs/supabase/config.ts'
export { SUPABASE_PROMPT } from './vfs/supabase/prompt.ts'
export {
  HF_VFS_NAMES,
  HfAccessor,
  HfBucketsAccessor,
  HfDatasetsAccessor,
  HfModelsAccessor,
  HfSpacesAccessor,
} from './accessor/hf.ts'
export { HfBucketsVFS, type HfBucketsVFSState } from './vfs/hf_buckets/hf_buckets.ts'
export {
  assertHfRepoId,
  HF_ENDPOINT,
  normalizeHfBucketsConfig,
  normalizeHfRepoConfig,
  redactHfBucketsConfig,
  redactHfRepoConfig,
  type HfBucketsConfig,
  type HfBucketsConfigRedacted,
  type HfRepoConfig,
  type HfRepoConfigRedacted,
} from './vfs/hf_buckets/config.ts'
export { HF_BUCKETS_PROMPT } from './vfs/hf_buckets/prompt.ts'
export { HfDatasetsVFS, type HfDatasetsVFSState } from './vfs/hf_datasets/hf_datasets.ts'
export { HF_DATASETS_PROMPT } from './vfs/hf_datasets/prompt.ts'
export { HfModelsVFS, type HfModelsVFSState } from './vfs/hf_models/hf_models.ts'
export {
  normalizeHfModelsConfig,
  redactHfModelsConfig,
  type HfModelsConfig,
  type HfModelsConfigRedacted,
} from './vfs/hf_models/config.ts'
export { HF_MODELS_PROMPT } from './vfs/hf_models/prompt.ts'
export { HfSpacesVFS, type HfSpacesVFSState } from './vfs/hf_spaces/hf_spaces.ts'
export { HF_SPACES_PROMPT } from './vfs/hf_spaces/prompt.ts'
export { HF_COMMANDS } from './commands/builtin/hf/index.ts'
export { HF_OPS } from './ops/hf/index.ts'
export { HF_HUB_COMMANDS } from './commands/builtin/hf_hub/index.ts'
export { HF_HUB_OPS } from './ops/hf_hub/index.ts'
export { MinIOVFS, type MinIOVFSState } from './vfs/minio/minio.ts'
export {
  redactMinIOConfig,
  type MinIOConfig,
  type MinIOConfigRedacted,
} from './vfs/minio/config.ts'
export { MINIO_PROMPT } from './vfs/minio/prompt.ts'
export { SeaweedFSVFS, type SeaweedFSVFSState } from './vfs/seaweedfs/seaweedfs.ts'
export {
  redactSeaweedFSConfig,
  type SeaweedFSConfig,
  type SeaweedFSConfigRedacted,
} from './vfs/seaweedfs/config.ts'
export { SEAWEEDFS_PROMPT } from './vfs/seaweedfs/prompt.ts'
export { CephVFS, type CephVFSState } from './vfs/ceph/ceph.ts'
export { redactCephConfig, type CephConfig, type CephConfigRedacted } from './vfs/ceph/config.ts'
export { CEPH_PROMPT } from './vfs/ceph/prompt.ts'
export { WasabiVFS, type WasabiVFSState } from './vfs/wasabi/wasabi.ts'
export {
  redactWasabiConfig,
  resolvedWasabiEndpoint,
  type WasabiConfig,
  type WasabiConfigRedacted,
} from './vfs/wasabi/config.ts'
export { WASABI_PROMPT } from './vfs/wasabi/prompt.ts'
export { BackblazeVFS, type BackblazeVFSState } from './vfs/backblaze/backblaze.ts'
export {
  redactBackblazeConfig,
  resolvedBackblazeEndpoint,
  type BackblazeConfig,
  type BackblazeConfigRedacted,
} from './vfs/backblaze/config.ts'
export { BACKBLAZE_PROMPT } from './vfs/backblaze/prompt.ts'
export { DigitalOceanVFS, type DigitalOceanVFSState } from './vfs/digitalocean/digitalocean.ts'
export {
  redactDigitalOceanConfig,
  resolvedDigitalOceanEndpoint,
  type DigitalOceanConfig,
  type DigitalOceanConfigRedacted,
} from './vfs/digitalocean/config.ts'
export { DIGITALOCEAN_PROMPT } from './vfs/digitalocean/prompt.ts'
export { TencentVFS, type TencentVFSState } from './vfs/tencent/tencent.ts'
export {
  redactTencentConfig,
  resolvedTencentEndpoint,
  type TencentConfig,
  type TencentConfigRedacted,
} from './vfs/tencent/config.ts'
export { TENCENT_PROMPT } from './vfs/tencent/prompt.ts'
export { AliyunVFS, type AliyunVFSState } from './vfs/aliyun/aliyun.ts'
export {
  redactAliyunConfig,
  resolvedAliyunEndpoint,
  type AliyunConfig,
  type AliyunConfigRedacted,
} from './vfs/aliyun/config.ts'
export { ALIYUN_PROMPT } from './vfs/aliyun/prompt.ts'
export { ScalewayVFS, type ScalewayVFSState } from './vfs/scaleway/scaleway.ts'
export {
  redactScalewayConfig,
  resolvedScalewayEndpoint,
  type ScalewayConfig,
  type ScalewayConfigRedacted,
} from './vfs/scaleway/config.ts'
export { SCALEWAY_PROMPT } from './vfs/scaleway/prompt.ts'
export { QingStorVFS, type QingStorVFSState } from './vfs/qingstor/qingstor.ts'
export {
  redactQingStorConfig,
  resolvedQingStorEndpoint,
  type QingStorConfig,
  type QingStorConfigRedacted,
} from './vfs/qingstor/config.ts'
export { QINGSTOR_PROMPT } from './vfs/qingstor/prompt.ts'
export { PostgresVFS, type PostgresVFSOptions } from './vfs/postgres/postgres.ts'
export { PostgresStore } from './vfs/postgres/store.ts'
export { MongoDBVFS, type MongoDBVFSOptions } from './vfs/mongodb/mongodb.ts'
export { MongoDBStore } from './vfs/mongodb/store.ts'
export { LanceDBVFS, type LanceDBVFSOptions } from './vfs/lancedb/lancedb.ts'
export { LanceDBStore } from './vfs/lancedb/store.ts'
export { SlackVFS, type SlackVFSState } from './vfs/slack/slack.ts'
export { normalizeSlackConfig, redactSlackConfig } from '@struktoai/mirage-core/core/slack/config'
export type { SlackConfig, SlackConfigRedacted } from '@struktoai/mirage-core/core/slack/config'
export { SSHVFS, type SSHVFSState } from './vfs/ssh/ssh.ts'
export {
  normalizeSshConfig,
  redactSshConfig,
  type SSHConfig,
  type SSHConfigRedacted,
} from './vfs/ssh/config.ts'
export { SSHAccessor } from './accessor/ssh.ts'
export { SSH_PROMPT } from './vfs/ssh/prompt.ts'
export { SSH_COMMANDS } from './commands/builtin/ssh/index.ts'
export { SSH_OPS } from './ops/ssh/index.ts'
export { NextcloudAccessor } from './accessor/nextcloud.ts'
export { NextcloudVFS, type NextcloudVFSState } from './vfs/nextcloud/nextcloud.ts'
export {
  normalizeNextcloudConfig,
  redactNextcloudConfig,
  type NextcloudConfig,
  type NextcloudConfigRedacted,
} from './vfs/nextcloud/config.ts'
export { NEXTCLOUD_PROMPT } from './vfs/nextcloud/prompt.ts'
export { NEXTCLOUD_COMMANDS } from './commands/builtin/nextcloud/index.ts'
export { NEXTCLOUD_OPS } from './ops/nextcloud/index.ts'
export { buildDeltaHook as buildNextcloudDeltaHook, NextcloudWalk } from './core/nextcloud/watch.ts'
export { DiscordVFS, type DiscordVFSState } from './vfs/discord/discord.ts'
export {
  normalizeDiscordConfig,
  redactDiscordConfig,
} from '@struktoai/mirage-core/core/discord/config'
export type {
  DiscordConfig,
  DiscordConfigRedacted,
} from '@struktoai/mirage-core/core/discord/config'
export { TrelloVFS, type TrelloVFSState } from './vfs/trello/trello.ts'
export {
  normalizeTrelloConfig,
  redactTrelloConfig,
  type TrelloConfig,
  type TrelloConfigRedacted,
} from './vfs/trello/config.ts'
export { LinearVFS, type LinearVFSState } from './vfs/linear/linear.ts'
export {
  normalizeLinearConfig,
  redactLinearConfig,
} from '@struktoai/mirage-core/core/linear/config'
export type { LinearConfig, LinearConfigRedacted } from '@struktoai/mirage-core/core/linear/config'
export { NotionVFS, type NotionVFSState } from './vfs/notion/notion.ts'
export {
  normalizeNotionConfig,
  redactNotionConfig,
} from '@struktoai/mirage-core/core/notion/config'
export type { NotionConfig, NotionConfigRedacted } from '@struktoai/mirage-core/core/notion/config'
// Named rather than left to the `export *` above: the three VFS classes come
// through it, but core's front door carries no config type of theirs, so
// dropping these lines would take them out of this package's API too.
export type { Mem0Config } from '@struktoai/mirage-core/vfs/mem0/config'
export type { OneDriveConfig } from '@struktoai/mirage-core/accessor/onedrive'
export type { SharePointConfig } from '@struktoai/mirage-core/accessor/sharepoint'
export { LangfuseVFS, type LangfuseVFSState } from './vfs/langfuse/langfuse.ts'
export { JaegerVFS, type JaegerVFSState } from './vfs/jaeger/jaeger.ts'
export {
  normalizeLangfuseConfig,
  redactLangfuseConfig,
  type LangfuseConfig,
  type LangfuseConfigRedacted,
} from './vfs/langfuse/config.ts'
export { GitHubVFS, type GitHubVFSState } from './vfs/github/github.ts'
export {
  normalizeGitHubConfig,
  redactGitHubConfig,
  type GitHubConfig,
  type GitHubConfigRedacted,
} from '@struktoai/mirage-core/core/github/config'
export { GDocsVFS, type GDocsVFSState } from './vfs/gdocs/gdocs.ts'
export {
  normalizeGDocsConfig,
  redactGDocsConfig,
  type GDocsConfig,
  type GDocsConfigRedacted,
} from '@struktoai/mirage-core/vfs/gdocs/config'
export { GSheetsVFS, type GSheetsVFSState } from './vfs/gsheets/gsheets.ts'
export {
  normalizeGSheetsConfig,
  redactGSheetsConfig,
  type GSheetsConfig,
  type GSheetsConfigRedacted,
} from '@struktoai/mirage-core/vfs/gsheets/config'
export { GSlidesVFS, type GSlidesVFSState } from './vfs/gslides/gslides.ts'
export {
  normalizeGSlidesConfig,
  redactGSlidesConfig,
  type GSlidesConfig,
  type GSlidesConfigRedacted,
} from '@struktoai/mirage-core/vfs/gslides/config'
export { GDriveVFS, type GDriveVFSState } from './vfs/gdrive/gdrive.ts'
export {
  normalizeGDriveConfig,
  redactGDriveConfig,
  type GDriveConfig,
  type GDriveConfigRedacted,
} from '@struktoai/mirage-core/vfs/gdrive/config'
export { DropboxVFS, type DropboxVFSState } from './vfs/dropbox/dropbox.ts'
export {
  normalizeDropboxConfig,
  redactDropboxConfig,
  type DropboxConfig,
  type DropboxConfigRedacted,
} from './vfs/dropbox/config.ts'
export { BoxVFS, type BoxVFSState } from './vfs/box/box.ts'
export {
  normalizeBoxConfig,
  redactBoxConfig,
  type BoxConfig,
  type BoxConfigRedacted,
} from './vfs/box/config.ts'
export { GmailVFS, type GmailVFSState } from './vfs/gmail/gmail.ts'
export {
  normalizeGmailConfig,
  redactGmailConfig,
  type GmailConfig,
  type GmailConfigRedacted,
} from '@struktoai/mirage-core/vfs/gmail/config'
export { GCalVFS, type GCalVFSState } from './vfs/gcal/gcal.ts'
export {
  normalizeGCalConfig,
  redactGCalConfig,
  type GCalConfig,
  type GCalConfigRedacted,
} from '@struktoai/mirage-core/vfs/gcal/config'
export { EmailVFS, type EmailVFSState } from './vfs/email/email.ts'
export {
  buildEmailConfig,
  normalizeEmailConfig,
  redactEmailConfig,
  type EmailConfig,
  type EmailConfigInput,
  type EmailConfigRedacted,
  EMAIL_PROMPT,
  EMAIL_WRITE_PROMPT,
} from './vfs/email/index.ts'
export { EmailAccessor } from './accessor/email.ts'
export { EMAIL_COMMANDS } from './commands/builtin/email/index.ts'
export { HF } from './commands/cli/builtin/hf/index.ts'
export { HIMALAYA } from './commands/cli/builtin/himalaya/index.ts'
export { EMAIL_OPS } from './ops/email/index.ts'
export { DaytonaRuntime } from './runtime/sandbox/daytona/runtime.ts'
export { LocalRuntime } from './runtime/python/local.ts'
export { DAYTONA_CONFIG_KEYS, type DaytonaConfig } from './runtime/sandbox/daytona/config.ts'
export { E2BRuntime } from '@struktoai/mirage-core/runtime/sandbox/e2b/runtime'
export { E2B_CONFIG_KEYS, type E2BConfig } from '@struktoai/mirage-core/runtime/sandbox/e2b/config'
export { DockerRuntime } from './runtime/sandbox/docker/runtime.ts'
export { DOCKER_CONFIG_KEYS, type DockerConfig } from './runtime/sandbox/docker/config.ts'
export { SandlockRuntime } from './runtime/sandbox/sandlock/runtime.ts'
export type { SandlockConfig } from './runtime/sandbox/sandlock/config.ts'
export { SmolvmRuntime } from './runtime/sandbox/smolvm/runtime.ts'
export { SMOLVM_CONFIG_KEYS, type SmolvmConfig } from './runtime/sandbox/smolvm/config.ts'
export { SSHRuntime } from './runtime/sandbox/ssh/runtime.ts'
export { SSH_RUNTIME_CONFIG_KEYS, type SSHRuntimeConfig } from './runtime/sandbox/ssh/config.ts'
export {
  buildVfs,
  knownVfsNames,
  register as registerVfsFactory,
  type VFSFactory,
} from './vfs/registry.ts'
export { MODULE_SUFFIXES, isModulePath, loadAttr, splitRef } from './vfs/loader.ts'
export { DISK_COMMANDS } from './commands/builtin/disk/index.ts'
export { REDIS_COMMANDS } from '@struktoai/mirage-core/commands/builtin/redis/index'
export { GRIDFS_COMMANDS } from './commands/builtin/gridfs/index.ts'
export {
  absolutizeScripts,
  checkWorkspaceConfig,
  checkWorkspaceConfigFile,
  configToWorkspaceArgs,
  interpolateEnv,
  loadWorkspaceConfig,
  loadWorkspaceConfigFile,
  type MountBlock,
  type WorkspaceArgs,
  type WorkspaceConfigRaw,
} from './config.ts'

// The authoring surface: what a host reaches for to bring its own
// VFS, CLI, policy or runtime, and the types the Workspace's own
// signatures hand back. Core's barrel is the front door for a program
// that mounts and runs; these are the doors behind it, re-exported by
// module so a consumer of this package needs no second dependency on
// core to reach them (`@struktoai/mirage-core/<path>` works too).
export { BaseVFS, recordVfsRef, vfsRefOf } from '@struktoai/mirage-core/vfs/base'
export { op, type RegisteredOp } from '@struktoai/mirage-core/ops/registry'
export { makeGenericOps } from '@struktoai/mirage-core/ops/generic/factory'
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
  type Deny,
  type Explanation,
  Outcome,
  Scope,
  type SessionContext,
} from '@struktoai/mirage-core/policy/index'
export { LanguageRuntime } from '@struktoai/mirage-core/runtime/language'
export { RemoteSandbox } from '@struktoai/mirage-core/runtime/sandbox/base'
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
