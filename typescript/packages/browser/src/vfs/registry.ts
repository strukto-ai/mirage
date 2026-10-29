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
import type { RAMVFSOptions } from '@struktoai/mirage-core/vfs/ram/ram'
import type { ResolvedSource } from '@struktoai/mirage-core/secrets/types'
import type { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { parseConfigWithSchema, refuseUnknownKeys, z } from '@struktoai/mirage-core/vfs/secrets'
import { errorSummary } from '@struktoai/mirage-core/secrets/summary'
import { VFSConfigError } from '@struktoai/mirage-core/vfs/errors'
import type { OPFSVFSOptions } from './opfs/opfs.ts'
import type { RedisVFSOptions } from './redis/redis.ts'
import { normalizeFields } from '@struktoai/mirage-core/utils/normalize'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'

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
export type VFSFactory = (config: Record<string, unknown>) => Promise<BaseVFS>

// The backends that take their options without a schema, and the option
// names each takes, so a key outside these is refused rather than ignored,
// the way python refuses a constructor keyword its class does not take.
const RAM_OPTIONS: readonly (keyof RAMVFSOptions)[] = ['capacity']
const OPFS_OPTIONS: readonly (keyof OPFSVFSOptions)[] = ['root', 'capacity']
const REDIS_OPTIONS: readonly (keyof RedisVFSOptions)[] = [
  'url',
  'token',
  'keyPrefix',
  'fetchImpl',
  'capacity',
  'maxRequestBytes',
]

const REGISTRY: Record<string, VFSFactory> = {
  ram: async (config) => {
    refuseUnknownKeys(config, RAM_OPTIONS)
    const { RAMVFS } = await import('@struktoai/mirage-core/vfs/ram/ram')
    return new RAMVFS(normalizeFields(config) as RAMVFSOptions)
  },
  opfs: async (config) => {
    refuseUnknownKeys(config, OPFS_OPTIONS)
    const { OPFSVFS } = await import('./opfs/opfs.ts')
    const norm = normalizeFields(config)
    return new OPFSVFS(norm)
  },
  s3: async (config) => {
    const { S3VFS } = await import('./s3/s3.ts')
    const { S3ConfigSchema } = await import('./s3/config.ts')
    return new S3VFS(parseConfigWithSchema(S3ConfigSchema, config))
  },
  gcs: async (config) => {
    const { GCSVFS } = await import('./gcs/gcs.ts')
    const { GCSConfigSchema } = await import('./gcs/config.ts')
    return new GCSVFS(parseConfigWithSchema(GCSConfigSchema, config))
  },
  r2: async (config) => {
    const { R2VFS } = await import('./r2/r2.ts')
    const { R2ConfigSchema } = await import('./r2/config.ts')
    return new R2VFS(parseConfigWithSchema(R2ConfigSchema, config))
  },
  oci: async (config) => {
    const { OCIVFS } = await import('./oci/oci.ts')
    const { OCIConfigSchema } = await import('./oci/config.ts')
    return new OCIVFS(parseConfigWithSchema(OCIConfigSchema, config))
  },
  supabase: async (config) => {
    const { SupabaseVFS } = await import('./supabase/supabase.ts')
    const { SupabaseConfigSchema } = await import('./supabase/config.ts')
    return new SupabaseVFS(parseConfigWithSchema(SupabaseConfigSchema, config))
  },
  minio: async (config) => {
    const { MinIOVFS } = await import('./minio/minio.ts')
    const { MinIOConfigSchema } = await import('./minio/config.ts')
    return new MinIOVFS(parseConfigWithSchema(MinIOConfigSchema, config))
  },
  ceph: async (config) => {
    const { CephVFS } = await import('./ceph/ceph.ts')
    const { CephConfigSchema } = await import('./ceph/config.ts')
    return new CephVFS(parseConfigWithSchema(CephConfigSchema, config))
  },
  seaweedfs: async (config) => {
    const { SeaweedFSVFS } = await import('./seaweedfs/seaweedfs.ts')
    const { SeaweedFSConfigSchema } = await import('./seaweedfs/config.ts')
    return new SeaweedFSVFS(parseConfigWithSchema(SeaweedFSConfigSchema, config))
  },
  wasabi: async (config) => {
    const { WasabiVFS } = await import('./wasabi/wasabi.ts')
    const { WasabiConfigSchema } = await import('./wasabi/config.ts')
    return new WasabiVFS(parseConfigWithSchema(WasabiConfigSchema, config))
  },
  backblaze: async (config) => {
    const { BackblazeVFS } = await import('./backblaze/backblaze.ts')
    const { BackblazeConfigSchema } = await import('./backblaze/config.ts')
    return new BackblazeVFS(parseConfigWithSchema(BackblazeConfigSchema, config))
  },
  digitalocean: async (config) => {
    const { DigitalOceanVFS } = await import('./digitalocean/digitalocean.ts')
    const { DigitalOceanConfigSchema } = await import('./digitalocean/config.ts')
    return new DigitalOceanVFS(parseConfigWithSchema(DigitalOceanConfigSchema, config))
  },
  tencent: async (config) => {
    const { TencentVFS } = await import('./tencent/tencent.ts')
    const { TencentConfigSchema } = await import('./tencent/config.ts')
    return new TencentVFS(parseConfigWithSchema(TencentConfigSchema, config))
  },
  aliyun: async (config) => {
    const { AliyunVFS } = await import('./aliyun/aliyun.ts')
    const { AliyunConfigSchema } = await import('./aliyun/config.ts')
    return new AliyunVFS(parseConfigWithSchema(AliyunConfigSchema, config))
  },
  scaleway: async (config) => {
    const { ScalewayVFS } = await import('./scaleway/scaleway.ts')
    const { ScalewayConfigSchema } = await import('./scaleway/config.ts')
    return new ScalewayVFS(parseConfigWithSchema(ScalewayConfigSchema, config))
  },
  qingstor: async (config) => {
    const { QingStorVFS } = await import('./qingstor/qingstor.ts')
    const { QingStorConfigSchema } = await import('./qingstor/config.ts')
    return new QingStorVFS(parseConfigWithSchema(QingStorConfigSchema, config))
  },
  slack: async (config) => {
    const { SlackVFS } = await import('./slack/slack.ts')
    const { SlackConfigSchema } = await import('./slack/config.ts')
    return new SlackVFS(parseConfigWithSchema(SlackConfigSchema, config))
  },
  discord: async (config) => {
    const { DiscordVFS } = await import('./discord/discord.ts')
    const { DiscordConfigSchema } = await import('./discord/config.ts')
    return new DiscordVFS(parseConfigWithSchema(DiscordConfigSchema, config))
  },
  trello: async (config) => {
    const { TrelloVFS } = await import('@struktoai/mirage-core/vfs/trello/trello')
    const { TrelloConfigSchema } = await import('@struktoai/mirage-core/core/trello/config')
    return new TrelloVFS(parseConfigWithSchema(TrelloConfigSchema, config))
  },
  wandb: async (config) => {
    const { WandbVFS } = await import('@struktoai/mirage-core/vfs/wandb/wandb')
    const { WandbConfigSchema } = await import('@struktoai/mirage-core/core/wandb/config')
    return new WandbVFS(parseConfigWithSchema(WandbConfigSchema, config))
  },
  linear: async (config) => {
    const { LinearVFS } = await import('@struktoai/mirage-core/vfs/linear/linear')
    const { LinearConfigSchema } = await import('@struktoai/mirage-core/core/linear/config')
    return new LinearVFS(parseConfigWithSchema(LinearConfigSchema, config))
  },
  postgres: async (config) => {
    const { PostgresVFS } = await import('./postgres/postgres.ts')
    const { PostgresConfigSchema } = await import('@struktoai/mirage-core/vfs/postgres/config')
    return new PostgresVFS(parseConfigWithSchema(PostgresConfigSchema, config))
  },
  mongodb: async (config) => {
    const { MongoDBVFS } = await import('./mongodb/mongodb.ts')
    const { MongoDBConfigSchema } = await import('@struktoai/mirage-core/vfs/mongodb/config')
    return new MongoDBVFS(parseConfigWithSchema(MongoDBConfigSchema, config))
  },
  chroma: async (config) => {
    const { ChromaVFS } = await import('@struktoai/mirage-core/vfs/chroma/chroma')
    const { ChromaConfigSchema } = await import('@struktoai/mirage-core/vfs/chroma/config')
    return new ChromaVFS(parseConfigWithSchema(ChromaConfigSchema, config))
  },
  dify: async (config) => {
    const { DifyVFS } = await import('@struktoai/mirage-core/vfs/dify/dify')
    const { DifyConfigSchema } = await import('@struktoai/mirage-core/vfs/dify/config')
    return new DifyVFS(parseConfigWithSchema(DifyConfigSchema, config))
  },
  qdrant: async (config) => {
    const { QdrantVFS } = await import('@struktoai/mirage-core/vfs/qdrant/qdrant')
    const { QdrantConfigSchema } = await import('@struktoai/mirage-core/vfs/qdrant/config')
    return new QdrantVFS(parseConfigWithSchema(QdrantConfigSchema, config))
  },
  redis: async (config) => {
    refuseUnknownKeys(config, REDIS_OPTIONS)
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
    const { NotionConfigSchema } = await import('./notion/config.ts')
    return new NotionVFS(parseConfigWithSchema(NotionConfigSchema, config))
  },
  langfuse: async (config) => {
    const { LangfuseVFS } = await import('@struktoai/mirage-core/vfs/langfuse/langfuse')
    const { LangfuseConfigSchema } = await import('@struktoai/mirage-core/vfs/langfuse/config')
    return new LangfuseVFS(parseConfigWithSchema(LangfuseConfigSchema, config))
  },
  github: async (config) => {
    const { GitHubVFS } = await import('@struktoai/mirage-core/vfs/github/github')
    const { GitHubConfigSchema } = await import('@struktoai/mirage-core/core/github/config')
    return GitHubVFS.create(parseConfigWithSchema(GitHubConfigSchema, config))
  },
  gcal: async (config) => {
    const { GCalVFS } = await import('@struktoai/mirage-core/vfs/gcal/gcal')
    const { GCalConfigSchema } = await import('@struktoai/mirage-core/vfs/gcal/config')
    return new GCalVFS(parseConfigWithSchema(GCalConfigSchema, config))
  },
  gdocs: async (config) => {
    const { GDocsVFS } = await import('@struktoai/mirage-core/vfs/gdocs/gdocs')
    const { GDocsConfigSchema } = await import('@struktoai/mirage-core/vfs/gdocs/config')
    return new GDocsVFS(parseConfigWithSchema(GDocsConfigSchema, config))
  },
  gsheets: async (config) => {
    const { GSheetsVFS } = await import('@struktoai/mirage-core/vfs/gsheets/gsheets')
    const { GSheetsConfigSchema } = await import('@struktoai/mirage-core/vfs/gsheets/config')
    return new GSheetsVFS(parseConfigWithSchema(GSheetsConfigSchema, config))
  },
  gslides: async (config) => {
    const { GSlidesVFS } = await import('@struktoai/mirage-core/vfs/gslides/gslides')
    const { GSlidesConfigSchema } = await import('@struktoai/mirage-core/vfs/gslides/config')
    return new GSlidesVFS(parseConfigWithSchema(GSlidesConfigSchema, config))
  },
  gdrive: async (config) => {
    const { GoogleDriveVFS } = await import('@struktoai/mirage-core/vfs/gdrive/gdrive')
    const { GoogleDriveConfigSchema } = await import('@struktoai/mirage-core/vfs/gdrive/config')
    return new GoogleDriveVFS(parseConfigWithSchema(GoogleDriveConfigSchema, config))
  },
  onedrive: async (config) => {
    const { OneDriveConfigSchema } = await import('@struktoai/mirage-core/accessor/onedrive')
    const { OneDriveVFS } = await import('@struktoai/mirage-core/vfs/onedrive/onedrive')
    return new OneDriveVFS(parseConfigWithSchema(OneDriveConfigSchema, config))
  },
  sharepoint: async (config) => {
    const { SharePointConfigSchema } = await import('@struktoai/mirage-core/accessor/sharepoint')
    const { SharePointVFS } = await import('@struktoai/mirage-core/vfs/sharepoint/sharepoint')
    return new SharePointVFS(parseConfigWithSchema(SharePointConfigSchema, config))
  },
  airtable: async (config) => {
    const { AirtableConfigSchema } = await import('@struktoai/mirage-core/core/airtable/config')
    const { AirtableVFS } = await import('@struktoai/mirage-core/vfs/airtable/airtable')
    return new AirtableVFS(parseConfigWithSchema(AirtableConfigSchema, config))
  },
  mem0: async (config) => {
    const { Mem0ConfigSchema } = await import('@struktoai/mirage-core/vfs/mem0/config')
    const { Mem0VFS } = await import('@struktoai/mirage-core/vfs/mem0/mem0')
    return new Mem0VFS(parseConfigWithSchema(Mem0ConfigSchema, config))
  },
  dropbox: async (config) => {
    const { DropboxVFS } = await import('@struktoai/mirage-core/vfs/dropbox/dropbox')
    const { DropboxConfigSchema } = await import('@struktoai/mirage-core/vfs/dropbox/config')
    return new DropboxVFS(parseConfigWithSchema(DropboxConfigSchema, config))
  },
  box: async (config) => {
    const { BoxVFS } = await import('@struktoai/mirage-core/vfs/box/box')
    const { BoxConfigSchema } = await import('@struktoai/mirage-core/vfs/box/config')
    return new BoxVFS(parseConfigWithSchema(BoxConfigSchema, config))
  },
  gmail: async (config) => {
    const { GmailVFS } = await import('@struktoai/mirage-core/vfs/gmail/gmail')
    const { GmailConfigSchema } = await import('@struktoai/mirage-core/vfs/gmail/config')
    return new GmailVFS(parseConfigWithSchema(GmailConfigSchema, config))
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
export function registerVfs(name: string, factory: VFSFactory): void {
  if (name in REGISTRY) throw new Error(`cannot register '${name}': shadows a builtin`)
  CUSTOM[name] = factory
}

export async function buildVfs(
  name: string,
  config: Record<string, unknown> = {},
  sources?: Readonly<Record<string, ResolvedSource>>,
): Promise<BaseVFS> {
  // A `{from, ref, key}` in the config is fetched here, before the
  // VFS's own schema parses, so every credential reaches its
  // client as the plain string it already reads. Python resolves one
  // step earlier, in its config loader, because `build_vfs` is sync
  // by rule there. A config with no pointer does no I/O.
  const resolved = await resolveConfigSecrets(config, sources, `mounts.${name}.config`)
  const factory = REGISTRY[name] ?? CUSTOM[name]
  if (factory === undefined) {
    throw new Error(`unknown VFS ${JSON.stringify(name)}; known: ${knownVfsNames().join(', ')}`)
  }
  let built: BaseVFS
  try {
    built = await factory(resolved)
  } catch (err) {
    // A mount config is where a fetched credential lands, and the create
    // route answers this message as its 400 detail: zod's own rendering
    // would hand the refused value straight back. Field and code only, the
    // way python's `build_vfs` reports its config class.
    if (err instanceof z.ZodError) throw new VFSConfigError(`${name}: ${errorSummary(err)}`)
    throw err
  }
  return built
}
