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
import type { Resource } from '@struktoai/mirage-core/resource/base'
import { z } from '@struktoai/mirage-core/resource/secrets'
import { errorSummary } from '@struktoai/mirage-core/secrets/summary'
import { normalizeFields } from '@struktoai/mirage-core/utils/normalize'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import { recordResourceRef } from '@struktoai/mirage-core/resource/base'
import { loadAttr } from './loader.ts'

/**
 * Construct a resource by registry name. Mirrors Python's
 * `mirage.resource.registry.build_resource`.
 *
 * Each entry is an async factory that lazy-imports its module so that
 * importing this file doesn't pull in every backend's dependencies.
 * Only the resource you actually request gets loaded — important for
 * S3/Redis whose peer deps (`@aws-sdk/client-s3`, `redis`) are optional.
 *
 * Configs are normalized from Python-style snake_case (used in YAML and
 * by the Python `mirage.config` loader) to TS-idiomatic camelCase. So
 * the same YAML file works in both Python and TS.
 */
export type ResourceFactory = (config: Record<string, unknown>) => Promise<Resource>

const REGISTRY: Record<string, ResourceFactory> = {
  ram: async (_config) => {
    const { RAMResource } = await import('@struktoai/mirage-core/resource/ram/ram')
    return new RAMResource()
  },
  disk: async (config) => {
    const { DiskResource } = await import('./disk/disk.ts')
    const norm = normalizeFields(config) as { root: string }
    return new DiskResource(norm)
  },
  redis: async (config) => {
    const { RedisResource } = await import('./redis/redis.ts')
    const norm = normalizeFields(config)
    return new RedisResource(norm)
  },
  s3: async (config) => {
    const { S3Resource } = await import('./s3/s3.ts')
    const { normalizeS3Config } = await import('./s3/config.ts')
    return new S3Resource(normalizeS3Config(config))
  },
  gridfs: async (config) => {
    const { GridFSResource } = await import('./gridfs/gridfs.ts')
    const { normalizeGridFSConfig } = await import('./gridfs/config.ts')
    return new GridFSResource(normalizeGridFSConfig(config))
  },
  gcs: async (config) => {
    const { GCSResource } = await import('./gcs/gcs.ts')
    const { normalizeGcsConfig } = await import('./gcs/config.ts')
    return new GCSResource(normalizeGcsConfig(config))
  },
  oci: async (config) => {
    const { OCIResource } = await import('./oci/oci.ts')
    const { normalizeOciConfig } = await import('./oci/config.ts')
    return new OCIResource(normalizeOciConfig(config))
  },
  r2: async (config) => {
    const { R2Resource } = await import('./r2/r2.ts')
    const { normalizeR2Config } = await import('./r2/config.ts')
    return new R2Resource(normalizeR2Config(config))
  },
  hf_buckets: async (config) => {
    const { HfBucketsResource } = await import('./hf_buckets/hf_buckets.ts')
    const { normalizeHfBucketsConfig } = await import('./hf_buckets/config.ts')
    return new HfBucketsResource(normalizeHfBucketsConfig(config))
  },
  hf_datasets: async (config) => {
    const { HfDatasetsResource } = await import('./hf_datasets/hf_datasets.ts')
    const { normalizeHfRepoConfig } = await import('./hf_buckets/config.ts')
    return new HfDatasetsResource(normalizeHfRepoConfig(config))
  },
  hf_models: async (config) => {
    const { HfModelsResource } = await import('./hf_models/hf_models.ts')
    const { normalizeHfRepoConfig } = await import('./hf_buckets/config.ts')
    return new HfModelsResource(normalizeHfRepoConfig(config))
  },
  hf_spaces: async (config) => {
    const { HfSpacesResource } = await import('./hf_spaces/hf_spaces.ts')
    const { normalizeHfRepoConfig } = await import('./hf_buckets/config.ts')
    return new HfSpacesResource(normalizeHfRepoConfig(config))
  },
  supabase: async (config) => {
    const { SupabaseResource } = await import('./supabase/supabase.ts')
    const { normalizeSupabaseConfig } = await import('./supabase/config.ts')
    return new SupabaseResource(normalizeSupabaseConfig(config))
  },
  databricks_volume: async (config) => {
    const { DatabricksVolumeResource } = await import('./databricks_volume/databricks_volume.ts')
    const { normalizeDatabricksVolumeConfig } =
      await import('@struktoai/mirage-core/resource/databricks_volume/config')
    return DatabricksVolumeResource.create(normalizeDatabricksVolumeConfig(config))
  },
  minio: async (config) => {
    const { MinIOResource } = await import('./minio/minio.ts')
    const { normalizeMinIOConfig } = await import('./minio/config.ts')
    return new MinIOResource(normalizeMinIOConfig(config))
  },
  ceph: async (config) => {
    const { CephResource } = await import('./ceph/ceph.ts')
    const { normalizeCephConfig } = await import('./ceph/config.ts')
    return new CephResource(normalizeCephConfig(config))
  },
  seaweedfs: async (config) => {
    const { SeaweedFSResource } = await import('./seaweedfs/seaweedfs.ts')
    const { normalizeSeaweedFSConfig } = await import('./seaweedfs/config.ts')
    return new SeaweedFSResource(normalizeSeaweedFSConfig(config))
  },
  wasabi: async (config) => {
    const { WasabiResource } = await import('./wasabi/wasabi.ts')
    const { normalizeWasabiConfig } = await import('./wasabi/config.ts')
    return new WasabiResource(normalizeWasabiConfig(config))
  },
  backblaze: async (config) => {
    const { BackblazeResource } = await import('./backblaze/backblaze.ts')
    const { normalizeBackblazeConfig } = await import('./backblaze/config.ts')
    return new BackblazeResource(normalizeBackblazeConfig(config))
  },
  digitalocean: async (config) => {
    const { DigitalOceanResource } = await import('./digitalocean/digitalocean.ts')
    const { normalizeDigitalOceanConfig } = await import('./digitalocean/config.ts')
    return new DigitalOceanResource(normalizeDigitalOceanConfig(config))
  },
  tencent: async (config) => {
    const { TencentResource } = await import('./tencent/tencent.ts')
    const { normalizeTencentConfig } = await import('./tencent/config.ts')
    return new TencentResource(normalizeTencentConfig(config))
  },
  aliyun: async (config) => {
    const { AliyunResource } = await import('./aliyun/aliyun.ts')
    const { normalizeAliyunConfig } = await import('./aliyun/config.ts')
    return new AliyunResource(normalizeAliyunConfig(config))
  },
  scaleway: async (config) => {
    const { ScalewayResource } = await import('./scaleway/scaleway.ts')
    const { normalizeScalewayConfig } = await import('./scaleway/config.ts')
    return new ScalewayResource(normalizeScalewayConfig(config))
  },
  qingstor: async (config) => {
    const { QingStorResource } = await import('./qingstor/qingstor.ts')
    const { normalizeQingStorConfig } = await import('./qingstor/config.ts')
    return new QingStorResource(normalizeQingStorConfig(config))
  },
  postgres: async (config) => {
    const { PostgresResource } = await import('./postgres/postgres.ts')
    const { normalizePostgresConfig } =
      await import('@struktoai/mirage-core/resource/postgres/config')
    return new PostgresResource(normalizePostgresConfig(config))
  },
  mongodb: async (config) => {
    const { MongoDBResource } = await import('./mongodb/mongodb.ts')
    const { normalizeMongoDBConfig } =
      await import('@struktoai/mirage-core/resource/mongodb/config')
    return new MongoDBResource(normalizeMongoDBConfig(config))
  },
  chroma: async (config) => {
    const { ChromaResource } = await import('@struktoai/mirage-core/resource/chroma/chroma')
    const { normalizeChromaConfig } = await import('@struktoai/mirage-core/resource/chroma/config')
    return new ChromaResource(normalizeChromaConfig(config))
  },
  dify: async (config) => {
    const { DifyResource } = await import('@struktoai/mirage-core/resource/dify/dify')
    const { normalizeDifyConfig } = await import('@struktoai/mirage-core/resource/dify/config')
    return new DifyResource(normalizeDifyConfig(config))
  },
  qdrant: async (config) => {
    const { QdrantResource } = await import('@struktoai/mirage-core/resource/qdrant/qdrant')
    const { normalizeQdrantConfig } = await import('@struktoai/mirage-core/resource/qdrant/config')
    return new QdrantResource(normalizeQdrantConfig(config))
  },
  lancedb: async (config) => {
    const { LanceDBResource } = await import('./lancedb/lancedb.ts')
    const { normalizeLanceDBConfig } =
      await import('@struktoai/mirage-core/resource/lancedb/config')
    return new LanceDBResource(normalizeLanceDBConfig(config))
  },
  slack: async (config) => {
    const { SlackResource } = await import('./slack/slack.ts')
    const { normalizeSlackConfig } = await import('@struktoai/mirage-core/core/slack/config')
    return new SlackResource(normalizeSlackConfig(config))
  },
  ssh: async (config) => {
    const { SSHResource } = await import('./ssh/ssh.ts')
    const { normalizeSshConfig } = await import('./ssh/config.ts')
    return new SSHResource(normalizeSshConfig(config))
  },
  nextcloud: async (config) => {
    const { NextcloudResource } = await import('./nextcloud/nextcloud.ts')
    const { normalizeNextcloudConfig } = await import('./nextcloud/config.ts')
    return new NextcloudResource(normalizeNextcloudConfig(config))
  },
  discord: async (config) => {
    const { DiscordResource } = await import('./discord/discord.ts')
    const { normalizeDiscordConfig } = await import('@struktoai/mirage-core/core/discord/config')
    return new DiscordResource(normalizeDiscordConfig(config))
  },
  trello: async (config) => {
    const { TrelloResource } = await import('./trello/trello.ts')
    const { normalizeTrelloConfig } = await import('./trello/config.ts')
    return new TrelloResource(normalizeTrelloConfig(config))
  },
  linear: async (config) => {
    const { LinearResource } = await import('./linear/linear.ts')
    const { normalizeLinearConfig } = await import('@struktoai/mirage-core/core/linear/config')
    return new LinearResource(normalizeLinearConfig(config))
  },
  notion: async (config) => {
    const { NotionResource } = await import('./notion/notion.ts')
    const { normalizeNotionConfig } = await import('@struktoai/mirage-core/core/notion/config')
    return new NotionResource(normalizeNotionConfig(config))
  },
  langfuse: async (config) => {
    const { LangfuseResource } = await import('./langfuse/langfuse.ts')
    const { normalizeLangfuseConfig } = await import('./langfuse/config.ts')
    return new LangfuseResource(normalizeLangfuseConfig(config))
  },
  jaeger: async (config) => {
    const { JaegerResource } = await import('./jaeger/jaeger.ts')
    const { normalizeJaegerConfig } = await import('./jaeger/config.ts')
    return new JaegerResource(normalizeJaegerConfig(config))
  },
  github: async (config) => {
    const { GitHubResource } = await import('./github/github.ts')
    const { normalizeGitHubConfig } = await import('@struktoai/mirage-core/core/github/config')
    return GitHubResource.create(normalizeGitHubConfig(config))
  },
  gcal: async (config) => {
    const { GCalResource } = await import('./gcal/gcal.ts')
    const { normalizeGCalConfig } = await import('@struktoai/mirage-core/resource/gcal/config')
    return new GCalResource(normalizeGCalConfig(config))
  },
  gdocs: async (config) => {
    const { GDocsResource } = await import('./gdocs/gdocs.ts')
    const { normalizeGDocsConfig } = await import('@struktoai/mirage-core/resource/gdocs/config')
    return new GDocsResource(normalizeGDocsConfig(config))
  },
  gsheets: async (config) => {
    const { GSheetsResource } = await import('./gsheets/gsheets.ts')
    const { normalizeGSheetsConfig } =
      await import('@struktoai/mirage-core/resource/gsheets/config')
    return new GSheetsResource(normalizeGSheetsConfig(config))
  },
  gslides: async (config) => {
    const { GSlidesResource } = await import('./gslides/gslides.ts')
    const { normalizeGSlidesConfig } =
      await import('@struktoai/mirage-core/resource/gslides/config')
    return new GSlidesResource(normalizeGSlidesConfig(config))
  },
  gdrive: async (config) => {
    const { GDriveResource } = await import('./gdrive/gdrive.ts')
    const { normalizeGDriveConfig } = await import('@struktoai/mirage-core/resource/gdrive/config')
    return new GDriveResource(normalizeGDriveConfig(config))
  },
  onedrive: async (config) => {
    const { normalizeOneDriveConfig } = await import('@struktoai/mirage-core/accessor/onedrive')
    const { OneDriveResource } = await import('@struktoai/mirage-core/resource/onedrive/onedrive')
    return new OneDriveResource(normalizeOneDriveConfig(config))
  },
  sharepoint: async (config) => {
    const { normalizeSharePointConfig } = await import('@struktoai/mirage-core/accessor/sharepoint')
    const { SharePointResource } =
      await import('@struktoai/mirage-core/resource/sharepoint/sharepoint')
    return new SharePointResource(normalizeSharePointConfig(config))
  },
  mem0: async (config) => {
    const { normalizeMem0Config } = await import('@struktoai/mirage-core/resource/mem0/config')
    const { Mem0Resource } = await import('@struktoai/mirage-core/resource/mem0/mem0')
    return new Mem0Resource(normalizeMem0Config(config))
  },
  dropbox: async (config) => {
    const { DropboxResource } = await import('./dropbox/dropbox.ts')
    const { normalizeDropboxConfig } = await import('./dropbox/config.ts')
    return new DropboxResource(normalizeDropboxConfig(config))
  },
  box: async (config) => {
    const { BoxResource } = await import('./box/box.ts')
    const { normalizeBoxConfig } = await import('./box/config.ts')
    return new BoxResource(normalizeBoxConfig(config))
  },
  gmail: async (config) => {
    const { GmailResource } = await import('./gmail/gmail.ts')
    const { normalizeGmailConfig } = await import('@struktoai/mirage-core/resource/gmail/config')
    return new GmailResource(normalizeGmailConfig(config))
  },
  email: async (config) => {
    const { EmailResource } = await import('./email/email.ts')
    const { normalizeEmailConfig } = await import('../core/email/config.ts')
    return new EmailResource(normalizeEmailConfig(config))
  },
}

const CUSTOM: Record<string, ResourceFactory> = {}

/**
 * Look up every constructible name: builtins plus whatever `register()`
 * has added.
 */
export function knownResources(): string[] {
  return [...new Set([...Object.keys(REGISTRY), ...Object.keys(CUSTOM)])].sort(compareCodePoints)
}

/**
 * Register a custom resource factory under `name`. Builtin names cannot
 * be shadowed; re-registering a custom name replaces it. Mirrors
 * Python's `mirage.resource.registry.register_resource`, which keeps
 * builtins in REGISTRY and custom entries in a separate _CUSTOM dict so
 * a plugin cannot replace the builtin `s3` factory.
 */
export function register(name: string, factory: ResourceFactory): void {
  if (name in REGISTRY) throw new Error(`cannot register '${name}': shadows a builtin`)
  CUSTOM[name] = factory
}

// Every member `Resource` declares non-optionally, which is the whole set a
// mount reaches for whatever the backend is: `open`/`close` on the
// lifecycle, `getState`/`loadState` on save and load. Checking a subset only
// moves the failure later and into a frame the author never wrote, which is
// the very thing this guard exists to prevent: `open`/`close` alone accepted
// a class whose missing `getState` crashed `Workspace.save()` instead.
const RESOURCE_METHODS = ['open', 'close', 'getState', 'loadState'] as const

/**
 * The reason a loaded export cannot serve as a resource, or null when it
 * can.
 *
 * A string rather than a boolean because a colon reference loads whatever
 * the file exports, and "did not build a resource" does not tell the author
 * which member they forgot.
 *
 * Structural, and deliberately unlike the python twin, which checks
 * `isinstance(built, BaseResource)` instead. The contract differs because the
 * languages do: python's mount door already refuses a non-subclass
 * (`workspace/workspace/mounts.py::check_resource`), so a structural check
 * there would accept what a later door rejects. `Resource` here is an
 * interface, erased at runtime, so there is no subclass to test and nothing
 * downstream can ask for more than the members. Both guards end at the same
 * place: the name a resource is keyed by must not be empty.
 */
function resourceDefect(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return `built a ${typeof value}`
  const node = value as Record<string, unknown>
  const missing = RESOURCE_METHODS.filter((name) => typeof node[name] !== 'function')
  if (missing.length > 0) return `is missing ${missing.join(', ')}`
  // A resource is keyed by `kind`: it is how a command or op registered for
  // this backend is found, so an empty one silently registers nothing.
  if (typeof node.kind !== 'string' || node.kind === '') return 'has no kind'
  return null
}

/**
 * Build a resource from a colon reference naming a class directly.
 *
 * `static create` is honored ahead of the constructor because that is
 * how a backend whose setup needs I/O is spelled here (github and
 * databricks_volume both do), and it is the one thing this tier has that
 * Python's does not: `build_resource` is synchronous there, so an
 * out-of-tree Python class hydrates lazily instead.
 */
async function buildFromRef(ref: string, config: Record<string, unknown>): Promise<Resource> {
  const exported = await loadAttr(ref)
  if (typeof exported !== 'function') {
    throw new Error(`resource ref ${JSON.stringify(ref)} must name a class, got ${typeof exported}`)
  }
  const cls = exported as {
    create?: (config: Record<string, unknown>) => unknown
    new (config: Record<string, unknown>): unknown
  }
  const built = await (typeof cls.create === 'function' ? cls.create(config) : new cls(config))
  const defect = resourceDefect(built)
  if (defect !== null) {
    throw new Error(`resource ref ${JSON.stringify(ref)} ${defect}`)
  }
  return built as Resource
}

/**
 * Build a resource instance by registry name, or from a colon reference
 * naming a class directly (`./wiki.mjs:WikiResource`, or the package
 * specifier `my-pkg/backends:WikiResource`).
 *
 * Builtins win over custom registrations, and both win over a reference,
 * so a name can never be reinterpreted as code. Throws if the name is
 * neither. Mirrors the ladder in Python's `_resolve_entry`, minus its
 * entry-point rung: Node has no equivalent of `importlib.metadata`, so a
 * package ships a resource here by exporting it and being named.
 */
export async function buildResource(
  name: string,
  config: Record<string, unknown> = {},
  sources?: Readonly<Record<string, ResolvedSource>>,
): Promise<Resource> {
  // A `{from, ref, key}` in the config is fetched here, before the
  // resource's own schema parses, so every credential reaches its
  // client as the plain string it already reads. Python resolves one
  // step earlier, in its config door (`resolve_secrets`), because
  // `build_resource` is sync by rule there. A config with no pointer
  // does no I/O.
  const resolved = await resolveConfigSecrets(config, sources, `mounts.${name}.config`)
  const factory = REGISTRY[name] ?? CUSTOM[name]
  let built: Resource | null
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
    // way python's `build_resource` reports its config class.
    if (err instanceof z.ZodError) throw new Error(`${name}: ${errorSummary(err)}`)
    throw err
  }
  if (built === null) {
    throw new Error(
      `unknown resource ${JSON.stringify(name)}; known: ${knownResources().join(', ')}`,
    )
  }
  recordResourceRef(built, name)
  return built
}
