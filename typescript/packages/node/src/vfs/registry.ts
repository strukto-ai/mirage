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
import { type BaseVFS, VFS_BRAND } from '@struktoai/mirage-core/vfs/base'
import { parseConfigWithSchema, refuseUnknownKeys, z } from '@struktoai/mirage-core/vfs/secrets'
import { errorSummary } from '@struktoai/mirage-core/secrets/summary'
import { VFSConfigError } from '@struktoai/mirage-core/vfs/errors'
import { normalizeFields } from '@struktoai/mirage-core/utils/normalize'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import type { DiskVFSOptions } from './disk/disk.ts'
import { loadAttr } from '../utils/loader.ts'
import type { RedisVFSOptions } from './redis/redis.ts'

/**
 * Construct a VFS by registry name. Mirrors Python's
 * `mirage.vfs.registry.build_vfs`.
 *
 * Each entry is an async factory that lazy-imports its module so that
 * importing this file doesn't pull in every backend's dependencies.
 * Only the VFS you actually request gets loaded — important for
 * S3/Redis whose peer deps (`@aws-sdk/client-s3`, `redis`) are optional.
 *
 * Configs are normalized from Python-style snake_case (used in YAML and
 * by the Python `mirage.config` loader) to TS-idiomatic camelCase. So
 * the same YAML file works in both Python and TS.
 */
export type VFSFactory = (config: Record<string, unknown>) => Promise<BaseVFS>

// The backends that take their options without a schema, and the option
// names each takes. Python builds the same three from constructor keywords,
// so a key outside these is refused on both sides rather than ignored here.
const RAM_OPTIONS: readonly (keyof RAMVFSOptions)[] = ['capacity']
const DISK_OPTIONS: readonly (keyof DiskVFSOptions)[] = ['root', 'folderVersions', 'capacity']
const REDIS_OPTIONS: readonly (keyof RedisVFSOptions)[] = ['url', 'keyPrefix', 'capacity']

const REGISTRY: Record<string, VFSFactory> = {
  ram: async (config) => {
    refuseUnknownKeys(config, RAM_OPTIONS)
    const { RAMVFS } = await import('@struktoai/mirage-core/vfs/ram/ram')
    return new RAMVFS(normalizeFields(config) as RAMVFSOptions)
  },
  disk: async (config) => {
    refuseUnknownKeys(config, DISK_OPTIONS)
    const { DiskVFS } = await import('./disk/disk.ts')
    const norm = normalizeFields(config) as unknown as DiskVFSOptions
    return new DiskVFS(norm)
  },
  redis: async (config) => {
    refuseUnknownKeys(config, REDIS_OPTIONS)
    const { RedisVFS } = await import('./redis/redis.ts')
    const norm = normalizeFields(config)
    return new RedisVFS(norm)
  },
  s3: async (config) => {
    const { S3VFS } = await import('./s3/s3.ts')
    const { S3ConfigSchema } = await import('./s3/config.ts')
    return new S3VFS(parseConfigWithSchema(S3ConfigSchema, config))
  },
  gridfs: async (config) => {
    const { GridFSVFS } = await import('./gridfs/gridfs.ts')
    const { normalizeGridFSConfig } = await import('./gridfs/config.ts')
    return new GridFSVFS(normalizeGridFSConfig(config))
  },
  gcs: async (config) => {
    const { GCSVFS } = await import('./gcs/gcs.ts')
    const { GCSConfigSchema } = await import('./gcs/config.ts')
    return new GCSVFS(parseConfigWithSchema(GCSConfigSchema, config))
  },
  oci: async (config) => {
    const { OCIVFS } = await import('./oci/oci.ts')
    const { OCIConfigSchema } = await import('./oci/config.ts')
    return new OCIVFS(parseConfigWithSchema(OCIConfigSchema, config))
  },
  r2: async (config) => {
    const { R2VFS } = await import('./r2/r2.ts')
    const { R2ConfigSchema } = await import('./r2/config.ts')
    return new R2VFS(parseConfigWithSchema(R2ConfigSchema, config))
  },
  hf_buckets: async (config) => {
    const { HfBucketsVFS } = await import('./hf_buckets/hf_buckets.ts')
    const { normalizeHfBucketsConfig } = await import('./hf_buckets/config.ts')
    return new HfBucketsVFS(normalizeHfBucketsConfig(config))
  },
  hf_datasets: async (config) => {
    const { HfDatasetsVFS } = await import('./hf_datasets/hf_datasets.ts')
    const { normalizeHfRepoConfig } = await import('./hf_buckets/config.ts')
    return new HfDatasetsVFS(normalizeHfRepoConfig(config))
  },
  hf_models: async (config) => {
    const { HfModelsVFS } = await import('./hf_models/hf_models.ts')
    const { normalizeHfRepoConfig } = await import('./hf_buckets/config.ts')
    return new HfModelsVFS(normalizeHfRepoConfig(config))
  },
  hf_spaces: async (config) => {
    const { HfSpacesVFS } = await import('./hf_spaces/hf_spaces.ts')
    const { normalizeHfRepoConfig } = await import('./hf_buckets/config.ts')
    return new HfSpacesVFS(normalizeHfRepoConfig(config))
  },
  supabase: async (config) => {
    const { SupabaseVFS } = await import('./supabase/supabase.ts')
    const { SupabaseConfigSchema } = await import('./supabase/config.ts')
    return new SupabaseVFS(parseConfigWithSchema(SupabaseConfigSchema, config))
  },
  databricks_volume: async (config) => {
    const { DatabricksVolumeVFS } = await import('./databricks_volume/databricks_volume.ts')
    const { DatabricksVolumeConfigSchema } =
      await import('@struktoai/mirage-core/vfs/databricks_volume/config')
    return DatabricksVolumeVFS.create(parseConfigWithSchema(DatabricksVolumeConfigSchema, config))
  },
  tidb_filesystem: async (config) => {
    const { TiDBFilesystemVFS } = await import('./tidb_filesystem/tidb_filesystem.ts')
    const { TiDBFilesystemConfigSchema } =
      await import('@struktoai/mirage-core/vfs/tidb_filesystem/config')
    return TiDBFilesystemVFS.create(parseConfigWithSchema(TiDBFilesystemConfigSchema, config))
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
  lancedb: async (config) => {
    const { LanceDBVFS } = await import('./lancedb/lancedb.ts')
    const { LanceDBConfigSchema } = await import('@struktoai/mirage-core/vfs/lancedb/config')
    return new LanceDBVFS(parseConfigWithSchema(LanceDBConfigSchema, config))
  },
  slack: async (config) => {
    const { SlackVFS } = await import('./slack/slack.ts')
    const { SlackConfigSchema } = await import('@struktoai/mirage-core/vfs/slack/config')
    return new SlackVFS(parseConfigWithSchema(SlackConfigSchema, config))
  },
  ssh: async (config) => {
    const { SSHVFS } = await import('./ssh/ssh.ts')
    const { SSHConfigSchema } = await import('./ssh/config.ts')
    return new SSHVFS(parseConfigWithSchema(SSHConfigSchema, config))
  },
  nextcloud: async (config) => {
    const { NextcloudVFS } = await import('./nextcloud/nextcloud.ts')
    const { NextcloudConfigSchema } = await import('./nextcloud/config.ts')
    return new NextcloudVFS(parseConfigWithSchema(NextcloudConfigSchema, config))
  },
  discord: async (config) => {
    const { DiscordVFS } = await import('./discord/discord.ts')
    const { DiscordConfigSchema } = await import('@struktoai/mirage-core/vfs/discord/config')
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
  notion: async (config) => {
    const { NotionVFS } = await import('./notion/notion.ts')
    const { NotionConfigSchema } = await import('@struktoai/mirage-core/core/notion/config')
    return new NotionVFS(parseConfigWithSchema(NotionConfigSchema, config))
  },
  langfuse: async (config) => {
    const { LangfuseVFS } = await import('@struktoai/mirage-core/vfs/langfuse/langfuse')
    const { LangfuseConfigSchema } = await import('@struktoai/mirage-core/vfs/langfuse/config')
    return new LangfuseVFS(parseConfigWithSchema(LangfuseConfigSchema, config))
  },
  jaeger: async (config) => {
    const { JaegerVFS } = await import('./jaeger/jaeger.ts')
    const { JaegerConfigSchema } = await import('./jaeger/config.ts')
    return new JaegerVFS(parseConfigWithSchema(JaegerConfigSchema, config))
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
    const { DropboxConfigSchema } = await import('./dropbox/config.ts')
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
  email: async (config) => {
    const { EmailVFS } = await import('./email/email.ts')
    const { EmailConfigSchema } = await import('../core/email/config.ts')
    return new EmailVFS(parseConfigWithSchema(EmailConfigSchema, config))
  },
}

const CUSTOM: Record<string, VFSFactory> = {}

/**
 * Look up every constructible name: builtins plus whatever `register()`
 * has added.
 */
export function knownVfsNames(): string[] {
  return [...new Set([...Object.keys(REGISTRY), ...Object.keys(CUSTOM)])].sort(compareCodePoints)
}

/**
 * Register a custom VFS factory under `name`. Builtin names cannot
 * be shadowed; re-registering a custom name replaces it. Mirrors
 * Python's `mirage.vfs.registry.register_vfs`, which keeps
 * builtins in REGISTRY and custom entries in a separate _CUSTOM dict so
 * a plugin cannot replace the builtin `s3` factory.
 */
export function registerVfs(name: string, factory: VFSFactory): void {
  if (name in REGISTRY) throw new Error(`cannot register '${name}': shadows a builtin`)
  CUSTOM[name] = factory
}

// The members a mount reaches for whatever the backend is: `close` on the
// lifecycle, `getState`/`loadState` on save and load. Checking a subset only
// moves the failure later and into a frame the author never wrote, which is
// the very thing this guard exists to prevent: `close` alone accepted a
// class whose missing `getState` crashed `Workspace.save()` instead.
/**
 * The reason a loaded export cannot serve as a VFS, or null when it
 * can.
 *
 * A string rather than a boolean because a colon reference loads whatever
 * the file exports, and "did not build a VFS" does not tell the author
 * what is wrong.
 *
 * The check is the `BaseVFS` brand, which is the same contract the python
 * twin enforces with `isinstance`. It is a brand rather than `instanceof`
 * because a script file may load its own copy of the package, and a real
 * subclass of that copy must pass; and a brand rather than a member list
 * because every member of the contract has a default, so nothing but
 * `name` could be probed for anyway.
 */
function vfsDefect(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return `built a ${typeof value}`
  const node = value as Record<PropertyKey, unknown>
  if (node[VFS_BRAND] !== true) return 'does not extend BaseVFS'
  // A VFS is keyed by `name`: it is how a command or op registered for
  // this backend is found, so an empty one silently registers nothing.
  if (typeof node.name !== 'string' || node.name === '') return 'has no name'
  return null
}

async function buildFromRef(ref: string, config: Record<string, unknown>): Promise<BaseVFS> {
  const exported = await loadAttr(ref)
  if (typeof exported !== 'function') {
    throw new Error(`VFS ref ${JSON.stringify(ref)} must name a class, got ${typeof exported}`)
  }
  const cls = exported as {
    create?: (config: Record<string, unknown>) => unknown
    new (config: Record<string, unknown>): unknown
  }
  const built = await (typeof cls.create === 'function' ? cls.create(config) : new cls(config))
  const defect = vfsDefect(built)
  if (defect !== null) {
    throw new Error(`VFS ref ${JSON.stringify(ref)} ${defect}`)
  }
  return built as BaseVFS
}

/**
 * Build a VFS instance by registry name, or from a colon reference
 * naming a class directly (`./wiki.mjs:WikiVFS`, or the package
 * specifier `my-pkg/backends:WikiVFS`).
 *
 * Builtins win over custom registrations, and both win over a reference,
 * so a name can never be reinterpreted as code. Throws if the name is
 * neither. Mirrors the ladder in Python's `_resolve_entry`, minus its
 * entry-point rung: Node has no equivalent of `importlib.metadata`, so a
 * package ships a VFS here by exporting it and being named.
 */
export async function buildVfs(
  name: string,
  config: Record<string, unknown> = {},
  sources?: Readonly<Record<string, ResolvedSource>>,
): Promise<BaseVFS> {
  // A `{from, ref, key}` in the config is fetched here, before the
  // VFS's own schema parses, so every credential reaches its
  // client as the plain string it already reads. Python resolves one
  // step earlier, in its config loader (`resolve_secrets`), because
  // `build_vfs` is sync by rule there. A config with no pointer
  // does no I/O.
  const resolved = await resolveConfigSecrets(config, sources, `mounts.${name}.config`)
  const factory = REGISTRY[name] ?? CUSTOM[name]
  let built: BaseVFS | null
  try {
    built =
      factory !== undefined
        ? await factory(resolved)
        : name.includes(':')
          ? await buildFromRef(name, resolved)
          : null
  } catch (err) {
    // A mount config is where a fetched credential lands, and the create
    // route answers this message as its 400 detail: zod's own rendering
    // would hand the refused value straight back. Field and code only, the
    // way python's `build_vfs` reports its config class.
    if (err instanceof z.ZodError) throw new VFSConfigError(`${name}: ${errorSummary(err)}`)
    throw err
  }
  if (built === null) {
    throw new Error(`unknown VFS ${JSON.stringify(name)}; known: ${knownVfsNames().join(', ')}`)
  }
  return built
}
