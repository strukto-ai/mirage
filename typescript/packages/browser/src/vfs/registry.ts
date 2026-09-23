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

import { resolveConfigSecrets } from '@struktoai/mirage-core/secrets/sources'
import type { ResolvedSource } from '@struktoai/mirage-core/secrets/types'
import type { VFS } from '@struktoai/mirage-core/vfs/base'
import { z } from '@struktoai/mirage-core/vfs/secrets'
import { errorSummary } from '@struktoai/mirage-core/secrets/summary'
import type { RedisVFSOptions } from './redis/redis.ts'
import { normalizeFields } from '@struktoai/mirage-core/utils/normalize'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import { recordVfsRef } from '@struktoai/mirage-core/vfs/base'

/**
 * Construct a VFS by registry name in the browser runtime.
 * Mirrors Python's `mirage.vfs.registry.build_vfs` and the
 * Node TS counterpart at `@struktoai/mirage-node/vfs/registry`.
 *
 * Configs are normalized from Python-style snake_case to TS camelCase so
 * the same YAML schema works across both runtimes.
 *
 * The S3 entry expects a browser-shaped config — bucket + a
 * `presignedUrlProvider` function. Since functions can't be encoded
 * in JSON/YAML, browser configs are typically constructed
 * programmatically and passed in directly.
 */
export type VFSFactory = (config: Record<string, unknown>) => Promise<VFS>

const REGISTRY: Record<string, VFSFactory> = {
  ram: async (_config) => {
    const { RAMVFS } = await import('@struktoai/mirage-core/vfs/ram/ram')
    return new RAMVFS()
  },
  opfs: async (config) => {
    const { OPFSVFS } = await import('./opfs/opfs.ts')
    const norm = normalizeFields(config)
    return new OPFSVFS(norm)
  },
  s3: async (config) => {
    const { S3VFS } = await import('./s3/s3.ts')
    const { normalizeS3Config } = await import('./s3/config.ts')
    return new S3VFS(normalizeS3Config(config))
  },
  gcs: async (config) => {
    const { GCSVFS } = await import('./gcs/gcs.ts')
    const { normalizeGCSConfig } = await import('./gcs/config.ts')
    return new GCSVFS(normalizeGCSConfig(config))
  },
  r2: async (config) => {
    const { R2VFS } = await import('./r2/r2.ts')
    const { normalizeR2Config } = await import('./r2/config.ts')
    return new R2VFS(normalizeR2Config(config))
  },
  oci: async (config) => {
    const { OCIVFS } = await import('./oci/oci.ts')
    const { normalizeOCIConfig } = await import('./oci/config.ts')
    return new OCIVFS(normalizeOCIConfig(config))
  },
  supabase: async (config) => {
    const { SupabaseVFS } = await import('./supabase/supabase.ts')
    const { normalizeSupabaseConfig } = await import('./supabase/config.ts')
    return new SupabaseVFS(normalizeSupabaseConfig(config))
  },
  minio: async (config) => {
    const { MinIOVFS } = await import('./minio/minio.ts')
    const { normalizeMinIOConfig } = await import('./minio/config.ts')
    return new MinIOVFS(normalizeMinIOConfig(config))
  },
  ceph: async (config) => {
    const { CephVFS } = await import('./ceph/ceph.ts')
    const { normalizeCephConfig } = await import('./ceph/config.ts')
    return new CephVFS(normalizeCephConfig(config))
  },
  seaweedfs: async (config) => {
    const { SeaweedFSVFS } = await import('./seaweedfs/seaweedfs.ts')
    const { normalizeSeaweedFSConfig } = await import('./seaweedfs/config.ts')
    return new SeaweedFSVFS(normalizeSeaweedFSConfig(config))
  },
  wasabi: async (config) => {
    const { WasabiVFS } = await import('./wasabi/wasabi.ts')
    const { normalizeWasabiConfig } = await import('./wasabi/config.ts')
    return new WasabiVFS(normalizeWasabiConfig(config))
  },
  backblaze: async (config) => {
    const { BackblazeVFS } = await import('./backblaze/backblaze.ts')
    const { normalizeBackblazeConfig } = await import('./backblaze/config.ts')
    return new BackblazeVFS(normalizeBackblazeConfig(config))
  },
  digitalocean: async (config) => {
    const { DigitalOceanVFS } = await import('./digitalocean/digitalocean.ts')
    const { normalizeDigitalOceanConfig } = await import('./digitalocean/config.ts')
    return new DigitalOceanVFS(normalizeDigitalOceanConfig(config))
  },
  tencent: async (config) => {
    const { TencentVFS } = await import('./tencent/tencent.ts')
    const { normalizeTencentConfig } = await import('./tencent/config.ts')
    return new TencentVFS(normalizeTencentConfig(config))
  },
  aliyun: async (config) => {
    const { AliyunVFS } = await import('./aliyun/aliyun.ts')
    const { normalizeAliyunConfig } = await import('./aliyun/config.ts')
    return new AliyunVFS(normalizeAliyunConfig(config))
  },
  scaleway: async (config) => {
    const { ScalewayVFS } = await import('./scaleway/scaleway.ts')
    const { normalizeScalewayConfig } = await import('./scaleway/config.ts')
    return new ScalewayVFS(normalizeScalewayConfig(config))
  },
  qingstor: async (config) => {
    const { QingStorVFS } = await import('./qingstor/qingstor.ts')
    const { normalizeQingStorConfig } = await import('./qingstor/config.ts')
    return new QingStorVFS(normalizeQingStorConfig(config))
  },
  slack: async (config) => {
    const { SlackVFS } = await import('./slack/slack.ts')
    const { normalizeSlackConfig } = await import('./slack/config.ts')
    return new SlackVFS(normalizeSlackConfig(config))
  },
  discord: async (config) => {
    const { DiscordVFS } = await import('./discord/discord.ts')
    const { normalizeDiscordConfig } = await import('./discord/config.ts')
    return new DiscordVFS(normalizeDiscordConfig(config))
  },
  trello: async (config) => {
    const { TrelloVFS } = await import('./trello/trello.ts')
    const { normalizeTrelloConfig } = await import('./trello/config.ts')
    return new TrelloVFS(normalizeTrelloConfig(config))
  },
  wandb: async (config) => {
    const { WandbVFS } = await import('@struktoai/mirage-core/vfs/wandb/wandb')
    const { normalizeWandbConfig } = await import('@struktoai/mirage-core/core/wandb/config')
    return new WandbVFS(normalizeWandbConfig(config))
  },
  linear: async (config) => {
    const { LinearVFS } = await import('./linear/linear.ts')
    const { normalizeLinearConfig } = await import('@struktoai/mirage-core/core/linear/config')
    return new LinearVFS(normalizeLinearConfig(config))
  },
  postgres: async (config) => {
    const { PostgresVFS } = await import('./postgres/postgres.ts')
    const { normalizePostgresConfig } = await import('@struktoai/mirage-core/vfs/postgres/config')
    return new PostgresVFS(normalizePostgresConfig(config))
  },
  mongodb: async (config) => {
    const { MongoDBVFS } = await import('./mongodb/mongodb.ts')
    const { normalizeMongoDBConfig } = await import('@struktoai/mirage-core/vfs/mongodb/config')
    return new MongoDBVFS(normalizeMongoDBConfig(config))
  },
  chroma: async (config) => {
    const { ChromaVFS } = await import('@struktoai/mirage-core/vfs/chroma/chroma')
    const { normalizeChromaConfig } = await import('@struktoai/mirage-core/vfs/chroma/config')
    return new ChromaVFS(normalizeChromaConfig(config))
  },
  dify: async (config) => {
    const { DifyVFS } = await import('@struktoai/mirage-core/vfs/dify/dify')
    const { normalizeDifyConfig } = await import('@struktoai/mirage-core/vfs/dify/config')
    return new DifyVFS(normalizeDifyConfig(config))
  },
  qdrant: async (config) => {
    const { QdrantVFS } = await import('@struktoai/mirage-core/vfs/qdrant/qdrant')
    const { normalizeQdrantConfig } = await import('@struktoai/mirage-core/vfs/qdrant/config')
    return new QdrantVFS(normalizeQdrantConfig(config))
  },
  redis: async (config) => {
    const { RedisVFS } = await import('./redis/redis.ts')
    return new RedisVFS(normalizeFields(config) as unknown as RedisVFSOptions)
  },
  lancedb: (_config) => {
    return Promise.reject(
      new Error(
        'LanceDBVFS is not supported in the browser: @lancedb/lancedb is a native ' +
          'Node addon. Use @struktoai/mirage-node from a server.',
      ),
    )
  },
  notion: async (config) => {
    const { NotionVFS } = await import('./notion/notion.ts')
    const { normalizeNotionConfig } = await import('./notion/config.ts')
    return new NotionVFS(normalizeNotionConfig(config))
  },
  langfuse: async (config) => {
    const { LangfuseVFS } = await import('./langfuse/langfuse.ts')
    const { normalizeLangfuseConfig } = await import('./langfuse/config.ts')
    return new LangfuseVFS(normalizeLangfuseConfig(config))
  },
  github: async (config) => {
    const { GitHubVFS } = await import('./github/github.ts')
    const { normalizeGitHubConfig } = await import('@struktoai/mirage-core/core/github/config')
    return GitHubVFS.create(normalizeGitHubConfig(config))
  },
  gcal: async (config) => {
    const { GCalVFS } = await import('./gcal/gcal.ts')
    const { normalizeGCalConfig } = await import('@struktoai/mirage-core/vfs/gcal/config')
    return new GCalVFS(normalizeGCalConfig(config))
  },
  gdocs: async (config) => {
    const { GDocsVFS } = await import('./gdocs/gdocs.ts')
    const { normalizeGDocsConfig } = await import('@struktoai/mirage-core/vfs/gdocs/config')
    return new GDocsVFS(normalizeGDocsConfig(config))
  },
  gsheets: async (config) => {
    const { GSheetsVFS } = await import('./gsheets/gsheets.ts')
    const { normalizeGSheetsConfig } = await import('@struktoai/mirage-core/vfs/gsheets/config')
    return new GSheetsVFS(normalizeGSheetsConfig(config))
  },
  gslides: async (config) => {
    const { GSlidesVFS } = await import('./gslides/gslides.ts')
    const { normalizeGSlidesConfig } = await import('@struktoai/mirage-core/vfs/gslides/config')
    return new GSlidesVFS(normalizeGSlidesConfig(config))
  },
  gdrive: async (config) => {
    const { GDriveVFS } = await import('./gdrive/gdrive.ts')
    const { normalizeGDriveConfig } = await import('@struktoai/mirage-core/vfs/gdrive/config')
    return new GDriveVFS(normalizeGDriveConfig(config))
  },
  onedrive: async (config) => {
    const { normalizeOneDriveConfig } = await import('@struktoai/mirage-core/accessor/onedrive')
    const { OneDriveVFS } = await import('@struktoai/mirage-core/vfs/onedrive/onedrive')
    return new OneDriveVFS(normalizeOneDriveConfig(config))
  },
  sharepoint: async (config) => {
    const { normalizeSharePointConfig } = await import('@struktoai/mirage-core/accessor/sharepoint')
    const { SharePointVFS } = await import('@struktoai/mirage-core/vfs/sharepoint/sharepoint')
    return new SharePointVFS(normalizeSharePointConfig(config))
  },
  mem0: async (config) => {
    const { normalizeMem0Config } = await import('@struktoai/mirage-core/vfs/mem0/config')
    const { Mem0VFS } = await import('@struktoai/mirage-core/vfs/mem0/mem0')
    return new Mem0VFS(normalizeMem0Config(config))
  },
  dropbox: async (config) => {
    const { DropboxVFS } = await import('./dropbox/dropbox.ts')
    const { normalizeDropboxConfig } = await import('./dropbox/config.ts')
    return new DropboxVFS(normalizeDropboxConfig(config))
  },
  box: async (config) => {
    const { BoxVFS } = await import('./box/box.ts')
    const { normalizeBoxConfig } = await import('./box/config.ts')
    return new BoxVFS(normalizeBoxConfig(config))
  },
  gmail: async (config) => {
    const { GmailVFS } = await import('./gmail/gmail.ts')
    const { normalizeGmailConfig } = await import('@struktoai/mirage-core/vfs/gmail/config')
    return new GmailVFS(normalizeGmailConfig(config))
  },
  email: (_config) => {
    return Promise.reject(
      new Error(
        'EmailVFS is not supported in the browser: IMAP/SMTP require raw TCP. ' +
          'Use @struktoai/mirage-node from a server, or proxy IMAP/SMTP via a backend.',
      ),
    )
  },
}

const CUSTOM: Record<string, VFSFactory> = {}

export function knownVfsNames(): string[] {
  return [...new Set([...Object.keys(REGISTRY), ...Object.keys(CUSTOM)])].sort(compareCodePoints)
}

/**
 * Register a custom VFS factory under `name`. Builtin names cannot
 * be shadowed; re-registering a custom name replaces it. Mirrors
 * Python's `register_vfs` and the Node counterpart.
 */
export function register(name: string, factory: VFSFactory): void {
  if (name in REGISTRY) throw new Error(`cannot register '${name}': shadows a builtin`)
  CUSTOM[name] = factory
}

export async function buildVfs(
  name: string,
  config: Record<string, unknown> = {},
  sources?: Readonly<Record<string, ResolvedSource>>,
): Promise<VFS> {
  // A `{from, ref, key}` in the config is fetched here, before the
  // VFS's own schema parses, so every credential reaches its
  // client as the plain string it already reads. Python resolves one
  // step earlier, in its config door, because `build_vfs` is sync
  // by rule there. A config with no pointer does no I/O.
  const resolved = await resolveConfigSecrets(config, sources, `mounts.${name}.config`)
  const factory = REGISTRY[name] ?? CUSTOM[name]
  if (factory === undefined) {
    throw new Error(`unknown VFS ${JSON.stringify(name)}; known: ${knownVfsNames().join(', ')}`)
  }
  let built: VFS
  try {
    built = await factory(resolved)
  } catch (err) {
    // A mount config is where a fetched credential lands, and the create
    // route answers this message as its 400 detail: zod's own rendering
    // would hand the refused value straight back. Field and code only, the
    // way python's `build_vfs` reports its config class.
    if (err instanceof z.ZodError) throw new Error(`${name}: ${errorSummary(err)}`)
    throw err
  }
  recordVfsRef(built, name)
  return built
}
