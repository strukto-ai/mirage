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
import { normalizeFields } from '@struktoai/mirage-core/utils/normalize'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import { recordVfsRef } from '@struktoai/mirage-core/vfs/base'
import { loadAttr } from './loader.ts'

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
export type VFSFactory = (config: Record<string, unknown>) => Promise<VFS>

const REGISTRY: Record<string, VFSFactory> = {
  ram: async (_config) => {
    const { RAMVFS } = await import('@struktoai/mirage-core/vfs/ram/ram')
    return new RAMVFS()
  },
  disk: async (config) => {
    const { DiskVFS } = await import('./disk/disk.ts')
    const norm = normalizeFields(config) as { root: string }
    return new DiskVFS(norm)
  },
  redis: async (config) => {
    const { RedisVFS } = await import('./redis/redis.ts')
    const norm = normalizeFields(config)
    return new RedisVFS(norm)
  },
  s3: async (config) => {
    const { S3VFS } = await import('./s3/s3.ts')
    const { normalizeS3Config } = await import('./s3/config.ts')
    return new S3VFS(normalizeS3Config(config))
  },
  gridfs: async (config) => {
    const { GridFSVFS } = await import('./gridfs/gridfs.ts')
    const { normalizeGridFSConfig } = await import('./gridfs/config.ts')
    return new GridFSVFS(normalizeGridFSConfig(config))
  },
  gcs: async (config) => {
    const { GCSVFS } = await import('./gcs/gcs.ts')
    const { normalizeGcsConfig } = await import('./gcs/config.ts')
    return new GCSVFS(normalizeGcsConfig(config))
  },
  oci: async (config) => {
    const { OCIVFS } = await import('./oci/oci.ts')
    const { normalizeOciConfig } = await import('./oci/config.ts')
    return new OCIVFS(normalizeOciConfig(config))
  },
  r2: async (config) => {
    const { R2VFS } = await import('./r2/r2.ts')
    const { normalizeR2Config } = await import('./r2/config.ts')
    return new R2VFS(normalizeR2Config(config))
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
    const { normalizeSupabaseConfig } = await import('./supabase/config.ts')
    return new SupabaseVFS(normalizeSupabaseConfig(config))
  },
  databricks_volume: async (config) => {
    const { DatabricksVolumeVFS } = await import('./databricks_volume/databricks_volume.ts')
    const { normalizeDatabricksVolumeConfig } =
      await import('@struktoai/mirage-core/vfs/databricks_volume/config')
    return DatabricksVolumeVFS.create(normalizeDatabricksVolumeConfig(config))
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
  lancedb: async (config) => {
    const { LanceDBVFS } = await import('./lancedb/lancedb.ts')
    const { normalizeLanceDBConfig } = await import('@struktoai/mirage-core/vfs/lancedb/config')
    return new LanceDBVFS(normalizeLanceDBConfig(config))
  },
  slack: async (config) => {
    const { SlackVFS } = await import('./slack/slack.ts')
    const { normalizeSlackConfig } = await import('@struktoai/mirage-core/core/slack/config')
    return new SlackVFS(normalizeSlackConfig(config))
  },
  ssh: async (config) => {
    const { SSHVFS } = await import('./ssh/ssh.ts')
    const { normalizeSshConfig } = await import('./ssh/config.ts')
    return new SSHVFS(normalizeSshConfig(config))
  },
  nextcloud: async (config) => {
    const { NextcloudVFS } = await import('./nextcloud/nextcloud.ts')
    const { normalizeNextcloudConfig } = await import('./nextcloud/config.ts')
    return new NextcloudVFS(normalizeNextcloudConfig(config))
  },
  discord: async (config) => {
    const { DiscordVFS } = await import('./discord/discord.ts')
    const { normalizeDiscordConfig } = await import('@struktoai/mirage-core/core/discord/config')
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
  notion: async (config) => {
    const { NotionVFS } = await import('./notion/notion.ts')
    const { normalizeNotionConfig } = await import('@struktoai/mirage-core/core/notion/config')
    return new NotionVFS(normalizeNotionConfig(config))
  },
  langfuse: async (config) => {
    const { LangfuseVFS } = await import('./langfuse/langfuse.ts')
    const { normalizeLangfuseConfig } = await import('./langfuse/config.ts')
    return new LangfuseVFS(normalizeLangfuseConfig(config))
  },
  jaeger: async (config) => {
    const { JaegerVFS } = await import('./jaeger/jaeger.ts')
    const { normalizeJaegerConfig } = await import('./jaeger/config.ts')
    return new JaegerVFS(normalizeJaegerConfig(config))
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
  email: async (config) => {
    const { EmailVFS } = await import('./email/email.ts')
    const { normalizeEmailConfig } = await import('../core/email/config.ts')
    return new EmailVFS(normalizeEmailConfig(config))
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
export function register(name: string, factory: VFSFactory): void {
  if (name in REGISTRY) throw new Error(`cannot register '${name}': shadows a builtin`)
  CUSTOM[name] = factory
}

// Every member `VFS` declares non-optionally, which is the whole set a
// mount reaches for whatever the backend is: `open`/`close` on the
// lifecycle, `getState`/`loadState` on save and load. Checking a subset only
// moves the failure later and into a frame the author never wrote, which is
// the very thing this guard exists to prevent: `open`/`close` alone accepted
// a class whose missing `getState` crashed `Workspace.save()` instead.
const VFS_METHODS = ['open', 'close', 'getState', 'loadState'] as const

/**
 * The reason a loaded export cannot serve as a VFS, or null when it
 * can.
 *
 * A string rather than a boolean because a colon reference loads whatever
 * the file exports, and "did not build a VFS" does not tell the author
 * which member they forgot.
 *
 * Structural, and deliberately unlike the python twin, which checks
 * `isinstance(built, BaseVFS)` instead. The contract differs because the
 * languages do: python's mount door already refuses a non-subclass
 * (`workspace/workspace/mounts.py::check_vfs`), so a structural check
 * there would accept what a later door rejects. `VFS` here is an
 * interface, erased at runtime, so there is no subclass to test and nothing
 * downstream can ask for more than the members. Both guards end at the same
 * place: the name a VFS is keyed by must not be empty.
 */
function vfsDefect(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return `built a ${typeof value}`
  const node = value as Record<string, unknown>
  const missing = VFS_METHODS.filter((name) => typeof node[name] !== 'function')
  if (missing.length > 0) return `is missing ${missing.join(', ')}`
  // A VFS is keyed by `kind`: it is how a command or op registered for
  // this backend is found, so an empty one silently registers nothing.
  if (typeof node.kind !== 'string' || node.kind === '') return 'has no kind'
  return null
}

/**
 * Build a VFS from a colon reference naming a class directly.
 *
 * `static create` is honored ahead of the constructor because that is
 * how a backend whose setup needs I/O is spelled here (github and
 * databricks_volume both do), and it is the one thing this tier has that
 * Python's does not: `build_vfs` is synchronous there, so an
 * out-of-tree Python class hydrates lazily instead.
 */
async function buildFromRef(ref: string, config: Record<string, unknown>): Promise<VFS> {
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
  return built as VFS
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
): Promise<VFS> {
  // A `{from, ref, key}` in the config is fetched here, before the
  // VFS's own schema parses, so every credential reaches its
  // client as the plain string it already reads. Python resolves one
  // step earlier, in its config door (`resolve_secrets`), because
  // `build_vfs` is sync by rule there. A config with no pointer
  // does no I/O.
  const resolved = await resolveConfigSecrets(config, sources, `mounts.${name}.config`)
  const factory = REGISTRY[name] ?? CUSTOM[name]
  let built: VFS | null
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
    if (err instanceof z.ZodError) throw new Error(`${name}: ${errorSummary(err)}`)
    throw err
  }
  if (built === null) {
    throw new Error(`unknown VFS ${JSON.stringify(name)}; known: ${knownVfsNames().join(', ')}`)
  }
  recordVfsRef(built, name)
  return built
}
