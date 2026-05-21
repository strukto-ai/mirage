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
export { Workspace } from './workspace.ts'
export {
  DiskResource,
  type DiskResourceOptions,
  type DiskResourceState,
} from './resource/disk/disk.ts'
export { DISK_PROMPT } from './resource/disk/prompt.ts'
export { DISK_OPS } from './ops/disk/index.ts'
export { patchNodeFs } from './fs_monkey.ts'
export {
  RedisResource,
  type RedisResourceOptions,
  type RedisResourceState,
} from './resource/redis/redis.ts'
export { REDIS_PROMPT } from './resource/redis/prompt.ts'
export { RedisStore, type RedisStoreOptions } from './resource/redis/store.ts'
export { RedisAccessor } from './accessor/redis.ts'
export { REDIS_OPS } from './ops/redis/index.ts'
export {
  fileReadProvision,
  headTailProvision,
  metadataProvision,
  type RedisResourceLike,
} from './commands/builtin/redis/provision.ts'
export { RedisFileCacheStore, type RedisFileCacheOptions } from './cache/redis/file.ts'
export { FuseManager } from './workspace/fuse.ts'
export { MirageFS, type MirageFSOptions, type FuseAttr } from './fuse/fs.ts'
export {
  nativeExec,
  nativeExecStream,
  type NativeExecOptions,
  type NativeExecResult,
  type NativeProcess,
} from './native.ts'
export {
  mount as fuseMount,
  mountBackground as fuseMountBackground,
  type FuseHandle,
  type MountOptions as FuseMountOptions,
} from './fuse/mount.ts'
export { isMacosMetadata } from './fuse/platform/macos.ts'
export { S3Resource, type S3ResourceState } from './resource/s3/s3.ts'
export {
  redactConfig as redactS3Config,
  type S3Config,
  type S3ConfigRedacted,
} from './resource/s3/config.ts'
export { GCSResource, type GCSResourceState } from './resource/gcs/gcs.ts'
export {
  GCS_ENDPOINT,
  redactGcsConfig,
  type GCSConfig,
  type GCSConfigRedacted,
} from './resource/gcs/config.ts'
export { GCS_PROMPT } from './resource/gcs/prompt.ts'
export { OCIResource, type OCIResourceState } from './resource/oci/oci.ts'
export { redactOciConfig, type OCIConfig, type OCIConfigRedacted } from './resource/oci/config.ts'
export { OCI_PROMPT } from './resource/oci/prompt.ts'
export { R2Resource, type R2ResourceState } from './resource/r2/r2.ts'
export { redactR2Config, type R2Config, type R2ConfigRedacted } from './resource/r2/config.ts'
export { R2_PROMPT } from './resource/r2/prompt.ts'
export { SupabaseResource, type SupabaseResourceState } from './resource/supabase/supabase.ts'
export {
  redactSupabaseConfig,
  resolvedSupabaseEndpoint,
  type SupabaseConfig,
  type SupabaseConfigRedacted,
} from './resource/supabase/config.ts'
export { SUPABASE_PROMPT } from './resource/supabase/prompt.ts'
export { PostgresResource, type PostgresResourceOptions } from './resource/postgres/postgres.ts'
export { PostgresStore } from './resource/postgres/store.ts'
export { MongoDBResource, type MongoDBResourceOptions } from './resource/mongodb/mongodb.ts'
export { MongoDBStore } from './resource/mongodb/store.ts'
export {
  SSCholarPaperResource,
  type SSCholarPaperResourceOptions,
} from './resource/sscholar/sscholar.ts'
export {
  SSCholarAuthorResource,
  type SSCholarAuthorResourceOptions,
} from './resource/sscholar/author.ts'
export { VercelResource, type VercelResourceOptions } from './resource/vercel/vercel.ts'
export { PostHogResource, type PostHogResourceOptions } from './resource/posthog/posthog.ts'
export { SlackResource, type SlackResourceState } from './resource/slack/slack.ts'
export {
  normalizeSlackConfig,
  redactSlackConfig,
  type SlackConfig,
  type SlackConfigRedacted,
} from './resource/slack/config.ts'
export { SSHResource, type SSHResourceState } from './resource/ssh/ssh.ts'
export {
  normalizeSshConfig,
  redactSshConfig,
  type SSHConfig,
  type SSHConfigRedacted,
} from './resource/ssh/config.ts'
export { SSHAccessor } from './accessor/ssh.ts'
export { SSH_PROMPT } from './resource/ssh/prompt.ts'
export { SSH_COMMANDS } from './commands/builtin/ssh/index.ts'
export { SSH_OPS } from './ops/ssh/index.ts'
export { DiscordResource, type DiscordResourceState } from './resource/discord/discord.ts'
export {
  normalizeDiscordConfig,
  redactDiscordConfig,
  type DiscordConfig,
  type DiscordConfigRedacted,
} from './resource/discord/config.ts'
export { TrelloResource, type TrelloResourceState } from './resource/trello/trello.ts'
export {
  normalizeTrelloConfig,
  redactTrelloConfig,
  type TrelloConfig,
  type TrelloConfigRedacted,
} from './resource/trello/config.ts'
export { LinearResource, type LinearResourceState } from './resource/linear/linear.ts'
export {
  normalizeLinearConfig,
  redactLinearConfig,
  type LinearConfig,
  type LinearConfigRedacted,
} from './resource/linear/config.ts'
export { LangfuseResource, type LangfuseResourceState } from './resource/langfuse/langfuse.ts'
export {
  normalizeLangfuseConfig,
  redactLangfuseConfig,
  type LangfuseConfig,
  type LangfuseConfigRedacted,
} from './resource/langfuse/config.ts'
export { GitHubResource, type GitHubResourceState } from './resource/github/github.ts'
export {
  normalizeGitHubConfig,
  redactGitHubConfig,
  type GitHubConfig,
  type GitHubConfigRedacted,
} from './resource/github/config.ts'
export { GitHubCIResource, type GitHubCIResourceState } from './resource/github_ci/github_ci.ts'
export {
  normalizeGitHubCIConfig,
  redactGitHubCIConfig,
  type GitHubCIConfig,
  type GitHubCIConfigRedacted,
} from './resource/github_ci/config.ts'
export { GDocsResource, type GDocsResourceState } from './resource/gdocs/gdocs.ts'
export {
  normalizeGDocsConfig,
  redactGDocsConfig,
  type GDocsConfig,
  type GDocsConfigRedacted,
} from './resource/gdocs/config.ts'
export { GSheetsResource, type GSheetsResourceState } from './resource/gsheets/gsheets.ts'
export {
  normalizeGSheetsConfig,
  redactGSheetsConfig,
  type GSheetsConfig,
  type GSheetsConfigRedacted,
} from './resource/gsheets/config.ts'
export { GSlidesResource, type GSlidesResourceState } from './resource/gslides/gslides.ts'
export {
  normalizeGSlidesConfig,
  redactGSlidesConfig,
  type GSlidesConfig,
  type GSlidesConfigRedacted,
} from './resource/gslides/config.ts'
export { GDriveResource, type GDriveResourceState } from './resource/gdrive/gdrive.ts'
export {
  normalizeGDriveConfig,
  redactGDriveConfig,
  type GDriveConfig,
  type GDriveConfigRedacted,
} from './resource/gdrive/config.ts'
export { DropboxResource, type DropboxResourceState } from './resource/dropbox/dropbox.ts'
export {
  normalizeDropboxConfig,
  redactDropboxConfig,
  type DropboxConfig,
  type DropboxConfigRedacted,
} from './resource/dropbox/config.ts'
export { BoxResource, type BoxResourceState } from './resource/box/box.ts'
export {
  normalizeBoxConfig,
  redactBoxConfig,
  type BoxConfig,
  type BoxConfigRedacted,
} from './resource/box/config.ts'
export { GmailResource, type GmailResourceState } from './resource/gmail/gmail.ts'
export {
  normalizeGmailConfig,
  redactGmailConfig,
  type GmailConfig,
  type GmailConfigRedacted,
} from './resource/gmail/config.ts'
export { EmailResource, type EmailResourceState } from './resource/email/email.ts'
export {
  buildEmailConfig,
  normalizeEmailConfig,
  redactEmailConfig,
  type EmailConfig,
  type EmailConfigInput,
  type EmailConfigRedacted,
  EMAIL_PROMPT,
  EMAIL_WRITE_PROMPT,
} from './resource/email/index.ts'
export { EmailAccessor } from './accessor/email.ts'
export { EMAIL_COMMANDS } from './commands/builtin/email/index.ts'
export { EMAIL_OPS } from './ops/email/index.ts'
export {
  buildResource,
  knownResources,
  register as registerResourceFactory,
  type ResourceFactory,
} from './resource/registry.ts'
export { DISK_COMMANDS } from './commands/builtin/disk/index.ts'
export { REDIS_COMMANDS } from './commands/builtin/redis/index.ts'
export {
  LOCAL_AUDIO_COMMANDS,
  DISK_LOCAL_AUDIO_COMMANDS,
  RAM_LOCAL_AUDIO_COMMANDS,
  configure as configureLocalAudio,
  getConfig as getLocalAudioConfig,
  transcribe as localAudioTranscribe,
  metadata as localAudioMetadata,
  estimateByteRange as localAudioEstimateByteRange,
  formatDuration as localAudioFormatDuration,
  formatMetadata as localAudioFormatMetadata,
  type LocalAudioMetadata,
  type LocalAudioConfig,
  type LocalAudioTranscriber,
} from './commands/local_audio/index.ts'
