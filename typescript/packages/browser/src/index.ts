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
export { MountMode } from '@struktoai/mirage-core'
export { Workspace } from './workspace.ts'
export {
  OPFSResource,
  type OPFSResourceOptions,
  type OPFSResourceState,
} from './resource/opfs/opfs.ts'
export { OPFS_PROMPT } from './resource/opfs/prompt.ts'
export { OPFS_OPS } from './ops/opfs/index.ts'
export { OPFSAccessor } from './accessor/opfs.ts'
export { OPFS_COMMANDS } from './commands/builtin/opfs/index.ts'
export { S3Resource, S3_BROWSER_PROMPT, type S3ResourceState } from './resource/s3/s3.ts'
export {
  redactConfig as redactS3Config,
  type S3BrowserOperation,
  type S3BrowserPresignedUrlProvider,
  type S3BrowserSignOptions,
  type S3Config,
  type S3ConfigRedacted,
} from './resource/s3/config.ts'
export { GCSResource, type GCSResourceState } from './resource/gcs/gcs.ts'
export { GCS_BROWSER_PROMPT } from './resource/gcs/prompt.ts'
export {
  redactGcsConfig,
  gcsToS3Config,
  type GCSConfig,
  type GCSConfigRedacted,
} from './resource/gcs/config.ts'
export { R2Resource, type R2ResourceState } from './resource/r2/r2.ts'
export { R2_BROWSER_PROMPT } from './resource/r2/prompt.ts'
export {
  redactR2Config,
  r2ToS3Config,
  resolvedR2Endpoint,
  type R2Config,
  type R2ConfigRedacted,
} from './resource/r2/config.ts'
export { OCIResource, type OCIResourceState } from './resource/oci/oci.ts'
export { OCI_BROWSER_PROMPT } from './resource/oci/prompt.ts'
export {
  redactOciConfig,
  ociToS3Config,
  resolvedOciEndpoint,
  type OCIConfig,
  type OCIConfigRedacted,
} from './resource/oci/config.ts'
export { SupabaseResource, type SupabaseResourceState } from './resource/supabase/supabase.ts'
export { SUPABASE_BROWSER_PROMPT } from './resource/supabase/prompt.ts'
export {
  redactSupabaseConfig,
  supabaseToS3Config,
  resolvedSupabaseEndpoint,
  type SupabaseConfig,
  type SupabaseConfigRedacted,
} from './resource/supabase/config.ts'
export { MinIOResource, type MinIOResourceState } from './resource/minio/minio.ts'
export { MINIO_BROWSER_PROMPT } from './resource/minio/prompt.ts'
export {
  redactMinIOConfig,
  minioToS3Config,
  type MinIOConfig,
  type MinIOConfigRedacted,
} from './resource/minio/config.ts'
export { SeaweedFSResource, type SeaweedFSResourceState } from './resource/seaweedfs/seaweedfs.ts'
export { SEAWEEDFS_BROWSER_PROMPT } from './resource/seaweedfs/prompt.ts'
export {
  redactSeaweedFSConfig,
  seaweedfsToS3Config,
  type SeaweedFSConfig,
  type SeaweedFSConfigRedacted,
} from './resource/seaweedfs/config.ts'
export { CephResource, type CephResourceState } from './resource/ceph/ceph.ts'
export { CEPH_BROWSER_PROMPT } from './resource/ceph/prompt.ts'
export {
  redactCephConfig,
  cephToS3Config,
  type CephConfig,
  type CephConfigRedacted,
} from './resource/ceph/config.ts'
export { WasabiResource, type WasabiResourceState } from './resource/wasabi/wasabi.ts'
export { WASABI_BROWSER_PROMPT } from './resource/wasabi/prompt.ts'
export {
  redactWasabiConfig,
  wasabiToS3Config,
  resolvedWasabiEndpoint,
  type WasabiConfig,
  type WasabiConfigRedacted,
} from './resource/wasabi/config.ts'
export { BackblazeResource, type BackblazeResourceState } from './resource/backblaze/backblaze.ts'
export { BACKBLAZE_BROWSER_PROMPT } from './resource/backblaze/prompt.ts'
export {
  redactBackblazeConfig,
  backblazeToS3Config,
  resolvedBackblazeEndpoint,
  type BackblazeConfig,
  type BackblazeConfigRedacted,
} from './resource/backblaze/config.ts'
export {
  DigitalOceanResource,
  type DigitalOceanResourceState,
} from './resource/digitalocean/digitalocean.ts'
export { DIGITALOCEAN_BROWSER_PROMPT } from './resource/digitalocean/prompt.ts'
export {
  redactDigitalOceanConfig,
  digitalOceanToS3Config,
  resolvedDigitalOceanEndpoint,
  type DigitalOceanConfig,
  type DigitalOceanConfigRedacted,
} from './resource/digitalocean/config.ts'
export { TencentResource, type TencentResourceState } from './resource/tencent/tencent.ts'
export { TENCENT_BROWSER_PROMPT } from './resource/tencent/prompt.ts'
export {
  redactTencentConfig,
  tencentToS3Config,
  resolvedTencentEndpoint,
  type TencentConfig,
  type TencentConfigRedacted,
} from './resource/tencent/config.ts'
export { AliyunResource, type AliyunResourceState } from './resource/aliyun/aliyun.ts'
export { ALIYUN_BROWSER_PROMPT } from './resource/aliyun/prompt.ts'
export {
  redactAliyunConfig,
  aliyunToS3Config,
  resolvedAliyunEndpoint,
  type AliyunConfig,
  type AliyunConfigRedacted,
} from './resource/aliyun/config.ts'
export { ScalewayResource, type ScalewayResourceState } from './resource/scaleway/scaleway.ts'
export { SCALEWAY_BROWSER_PROMPT } from './resource/scaleway/prompt.ts'
export {
  redactScalewayConfig,
  scalewayToS3Config,
  resolvedScalewayEndpoint,
  type ScalewayConfig,
  type ScalewayConfigRedacted,
} from './resource/scaleway/config.ts'
export { QingStorResource, type QingStorResourceState } from './resource/qingstor/qingstor.ts'
export { QINGSTOR_BROWSER_PROMPT } from './resource/qingstor/prompt.ts'
export {
  redactQingStorConfig,
  qingStorToS3Config,
  resolvedQingStorEndpoint,
  type QingStorConfig,
  type QingStorConfigRedacted,
} from './resource/qingstor/config.ts'
export { SlackResource, type SlackResourceState } from './resource/slack/slack.ts'
export {
  redactSlackConfig,
  type SlackConfig,
  type SlackConfigRedacted,
} from './resource/slack/config.ts'
export { DiscordResource, type DiscordResourceState } from './resource/discord/discord.ts'
export {
  redactDiscordConfig,
  type DiscordConfig,
  type DiscordConfigRedacted,
} from './resource/discord/config.ts'
export { PostgresResource, type PostgresResourceOptions } from './resource/postgres/postgres.ts'
export { NeonPgDriver } from './resource/postgres/neon_driver.ts'
export { MongoDBResource, type MongoDBResourceOptions } from './resource/mongodb/mongodb.ts'
export { HttpMongoDriver, type HttpMongoDriverOptions } from './resource/mongodb/http_driver.ts'
export { TrelloResource, type TrelloResourceState } from './resource/trello/trello.ts'
export {
  redactTrelloConfig,
  type TrelloConfig,
  type TrelloConfigRedacted,
} from './resource/trello/config.ts'
export { LinearResource, type LinearResourceState } from './resource/linear/linear.ts'
export {
  redactLinearConfig,
  type LinearConfig,
  type LinearConfigRedacted,
} from './resource/linear/config.ts'
export { NotionResource, type NotionResourceState } from './resource/notion/notion.ts'
export {
  redactNotionConfig,
  type NotionConfig,
  type NotionConfigRedacted,
} from './resource/notion/config.ts'
export { LangfuseResource, type LangfuseResourceState } from './resource/langfuse/langfuse.ts'
export {
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
  Mem0Resource,
  OneDriveResource,
  SharePointResource,
  type Mem0Config,
  type OneDriveConfig,
  type SharePointConfig,
} from '@struktoai/mirage-core'
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
export {
  buildResource,
  knownResources,
  register as registerResourceFactory,
  type ResourceFactory,
} from './resource/registry.ts'
