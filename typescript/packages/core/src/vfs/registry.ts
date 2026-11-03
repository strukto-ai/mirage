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

import { resolveConfigSecrets } from '../secrets/sources.ts'
import { errorSummary } from '../secrets/summary.ts'
import type { ResolvedSource } from '../secrets/types.ts'
import { normalizeFields } from '../utils/normalize.ts'
import { compareCodePoints } from '../utils/sort.ts'
import type { BaseVFS } from './base.ts'
import { VFSConfigError } from './errors.ts'
import type { RAMVFSOptions } from './ram/ram.ts'
import { parseConfigWithSchema, refuseUnknownKeys, z } from './secrets.ts'

/**
 * Construct a VFS by registry name. Mirrors Python's
 * `mirage.vfs.registry.build_vfs`.
 *
 * Each entry is an async factory that lazy-imports its module so that
 * importing this file doesn't pull in every backend's dependencies.
 * This table holds the backends core implements, which every runtime
 * builds the same way; `@struktoai/mirage-node` and
 * `@struktoai/mirage-browser` add their own on top of it, and a runtime
 * with neither (an edge runtime) builds from this one alone.
 *
 * Configs are normalized from Python-style snake_case (used in YAML and
 * by the Python `mirage.config` loader) to TS-idiomatic camelCase. So
 * the same YAML file works in both Python and TS.
 */
export type VFSFactory = (config: Record<string, unknown>) => Promise<BaseVFS>

// The option names RAM takes without a schema. Python builds it from
// constructor keywords, so a key outside these is refused on both sides
// rather than ignored here.
const RAM_OPTIONS: readonly (keyof RAMVFSOptions)[] = ['capacity']

export const REGISTRY: Readonly<Record<string, VFSFactory>> = {
  ram: async (config) => {
    refuseUnknownKeys(config, RAM_OPTIONS)
    const { RAMVFS } = await import('./ram/ram.ts')
    return new RAMVFS(normalizeFields(config) as RAMVFSOptions)
  },
  chroma: async (config) => {
    const { ChromaVFS } = await import('./chroma/chroma.ts')
    const { ChromaConfig } = await import('./chroma/config.ts')
    return new ChromaVFS(parseConfigWithSchema(ChromaConfig, config))
  },
  dify: async (config) => {
    const { DifyVFS } = await import('./dify/dify.ts')
    const { DifyConfig } = await import('./dify/config.ts')
    return new DifyVFS(parseConfigWithSchema(DifyConfig, config))
  },
  qdrant: async (config) => {
    const { QdrantVFS } = await import('./qdrant/qdrant.ts')
    const { QdrantConfig } = await import('./qdrant/config.ts')
    return new QdrantVFS(parseConfigWithSchema(QdrantConfig, config))
  },
  trello: async (config) => {
    const { TrelloVFS } = await import('./trello/trello.ts')
    const { TrelloConfig } = await import('../core/trello/config.ts')
    return new TrelloVFS(parseConfigWithSchema(TrelloConfig, config))
  },
  wandb: async (config) => {
    const { WandbVFS } = await import('./wandb/wandb.ts')
    const { WandbConfig } = await import('../core/wandb/config.ts')
    return new WandbVFS(parseConfigWithSchema(WandbConfig, config))
  },
  linear: async (config) => {
    const { LinearVFS } = await import('./linear/linear.ts')
    const { LinearConfig } = await import('../core/linear/config.ts')
    return new LinearVFS(parseConfigWithSchema(LinearConfig, config))
  },
  langfuse: async (config) => {
    const { LangfuseVFS } = await import('./langfuse/langfuse.ts')
    const { LangfuseConfig } = await import('./langfuse/config.ts')
    return new LangfuseVFS(parseConfigWithSchema(LangfuseConfig, config))
  },
  github: async (config) => {
    const { GitHubVFS } = await import('./github/github.ts')
    const { GitHubConfig } = await import('../core/github/config.ts')
    return GitHubVFS.create(parseConfigWithSchema(GitHubConfig, config))
  },
  gcal: async (config) => {
    const { GCalVFS } = await import('./gcal/gcal.ts')
    const { GCalConfig } = await import('./gcal/config.ts')
    return new GCalVFS(parseConfigWithSchema(GCalConfig, config))
  },
  gdocs: async (config) => {
    const { GDocsVFS } = await import('./gdocs/gdocs.ts')
    const { GDocsConfig } = await import('./gdocs/config.ts')
    return new GDocsVFS(parseConfigWithSchema(GDocsConfig, config))
  },
  gsheets: async (config) => {
    const { GSheetsVFS } = await import('./gsheets/gsheets.ts')
    const { GSheetsConfig } = await import('./gsheets/config.ts')
    return new GSheetsVFS(parseConfigWithSchema(GSheetsConfig, config))
  },
  gslides: async (config) => {
    const { GSlidesVFS } = await import('./gslides/gslides.ts')
    const { GSlidesConfig } = await import('./gslides/config.ts')
    return new GSlidesVFS(parseConfigWithSchema(GSlidesConfig, config))
  },
  gdrive: async (config) => {
    const { GoogleDriveVFS } = await import('./gdrive/gdrive.ts')
    const { GoogleDriveConfig } = await import('./gdrive/config.ts')
    return new GoogleDriveVFS(parseConfigWithSchema(GoogleDriveConfig, config))
  },
  onedrive: async (config) => {
    const { OneDriveConfig } = await import('../accessor/onedrive.ts')
    const { OneDriveVFS } = await import('./onedrive/onedrive.ts')
    return new OneDriveVFS(parseConfigWithSchema(OneDriveConfig, config))
  },
  sharepoint: async (config) => {
    const { SharePointConfig } = await import('../accessor/sharepoint.ts')
    const { SharePointVFS } = await import('./sharepoint/sharepoint.ts')
    return new SharePointVFS(parseConfigWithSchema(SharePointConfig, config))
  },
  airtable: async (config) => {
    const { AirtableConfig } = await import('../core/airtable/config.ts')
    const { AirtableVFS } = await import('./airtable/airtable.ts')
    return new AirtableVFS(parseConfigWithSchema(AirtableConfig, config))
  },
  mem0: async (config) => {
    const { Mem0Config } = await import('./mem0/config.ts')
    const { Mem0VFS } = await import('./mem0/mem0.ts')
    return new Mem0VFS(parseConfigWithSchema(Mem0Config, config))
  },
  box: async (config) => {
    const { BoxVFS } = await import('./box/box.ts')
    const { BoxConfig } = await import('./box/config.ts')
    return new BoxVFS(parseConfigWithSchema(BoxConfig, config))
  },
  gmail: async (config) => {
    const { GmailVFS } = await import('./gmail/gmail.ts')
    const { GmailConfig } = await import('./gmail/config.ts')
    return new GmailVFS(parseConfigWithSchema(GmailConfig, config))
  },
}

/**
 * The backends a host that may hold their credential builds: each takes
 * its token in the config and reaches its service with `fetch` (`direct/`).
 * Node and edge runtimes build these on top of {@link REGISTRY}; the
 * browser builds its own, which leave the token to a proxy, so this table
 * is kept apart rather than in core's own `buildVfs`.
 */
export const DIRECT_REGISTRY: Readonly<Record<string, VFSFactory>> = {
  slack: async (config) => {
    const { SlackVFS } = await import('./direct/slack.ts')
    const { SlackConfig } = await import('./slack/config.ts')
    return new SlackVFS(parseConfigWithSchema(SlackConfig, config))
  },
  discord: async (config) => {
    const { DiscordVFS } = await import('./direct/discord.ts')
    const { DiscordConfig } = await import('./discord/config.ts')
    return new DiscordVFS(parseConfigWithSchema(DiscordConfig, config))
  },
  notion: async (config) => {
    const { NotionVFS } = await import('./direct/notion.ts')
    const { NotionConfig } = await import('../core/notion/config.ts')
    return new NotionVFS(parseConfigWithSchema(NotionConfig, config))
  },
  jaeger: async (config) => {
    const { JaegerVFS } = await import('./direct/jaeger.ts')
    const { JaegerConfig } = await import('./jaeger/config.ts')
    return new JaegerVFS(parseConfigWithSchema(JaegerConfig, config))
  },
  databricks_volume: async (config) => {
    const { DatabricksVolumeVFS } = await import('./direct/databricks_volume.ts')
    const { DatabricksVolumeConfig } = await import('./databricks_volume/config.ts')
    return DatabricksVolumeVFS.create(parseConfigWithSchema(DatabricksVolumeConfig, config))
  },
  tidb_filesystem: async (config) => {
    const { TiDBFilesystemVFS } = await import('./direct/tidb_filesystem.ts')
    const { TiDBFilesystemConfig } = await import('./tidb_filesystem/config.ts')
    return TiDBFilesystemVFS.create(parseConfigWithSchema(TiDBFilesystemConfig, config))
  },
  dropbox: async (config) => {
    const { DropboxVFS } = await import('./dropbox/dropbox.ts')
    const { DropboxConfig } = await import('./direct/dropbox.ts')
    return new DropboxVFS(parseConfigWithSchema(DropboxConfig, config))
  },
  s3: async (config) => {
    const { S3Config, S3VFS } = await import('./direct/s3.ts')
    return new S3VFS(parseConfigWithSchema(S3Config, config))
  },
  gcs: async (config) => {
    const { GCSVFS } = await import('./gcs/gcs.ts')
    const { GCSConfig } = await import('./gcs/config.ts')
    return new GCSVFS(parseConfigWithSchema(GCSConfig, config))
  },
  oci: async (config) => {
    const { OCIVFS } = await import('./oci/oci.ts')
    const { OCIConfig } = await import('./oci/config.ts')
    return new OCIVFS(parseConfigWithSchema(OCIConfig, config))
  },
  r2: async (config) => {
    const { R2VFS } = await import('./r2/r2.ts')
    const { R2Config } = await import('./r2/config.ts')
    return new R2VFS(parseConfigWithSchema(R2Config, config))
  },
  supabase: async (config) => {
    const { SupabaseVFS } = await import('./supabase/supabase.ts')
    const { SupabaseConfig } = await import('./supabase/config.ts')
    return new SupabaseVFS(parseConfigWithSchema(SupabaseConfig, config))
  },
  minio: async (config) => {
    const { MinIOVFS } = await import('./minio/minio.ts')
    const { MinIOConfig } = await import('./minio/config.ts')
    return new MinIOVFS(parseConfigWithSchema(MinIOConfig, config))
  },
  ceph: async (config) => {
    const { CephVFS } = await import('./ceph/ceph.ts')
    const { CephConfig } = await import('./ceph/config.ts')
    return new CephVFS(parseConfigWithSchema(CephConfig, config))
  },
  seaweedfs: async (config) => {
    const { SeaweedFSVFS } = await import('./seaweedfs/seaweedfs.ts')
    const { SeaweedFSConfig } = await import('./seaweedfs/config.ts')
    return new SeaweedFSVFS(parseConfigWithSchema(SeaweedFSConfig, config))
  },
  wasabi: async (config) => {
    const { WasabiVFS } = await import('./wasabi/wasabi.ts')
    const { WasabiConfig } = await import('./wasabi/config.ts')
    return new WasabiVFS(parseConfigWithSchema(WasabiConfig, config))
  },
  backblaze: async (config) => {
    const { BackblazeVFS } = await import('./backblaze/backblaze.ts')
    const { BackblazeConfig } = await import('./backblaze/config.ts')
    return new BackblazeVFS(parseConfigWithSchema(BackblazeConfig, config))
  },
  digitalocean: async (config) => {
    const { DigitalOceanVFS } = await import('./digitalocean/digitalocean.ts')
    const { DigitalOceanConfig } = await import('./digitalocean/config.ts')
    return new DigitalOceanVFS(parseConfigWithSchema(DigitalOceanConfig, config))
  },
  tencent: async (config) => {
    const { TencentVFS } = await import('./tencent/tencent.ts')
    const { TencentConfig } = await import('./tencent/config.ts')
    return new TencentVFS(parseConfigWithSchema(TencentConfig, config))
  },
  aliyun: async (config) => {
    const { AliyunVFS } = await import('./aliyun/aliyun.ts')
    const { AliyunConfig } = await import('./aliyun/config.ts')
    return new AliyunVFS(parseConfigWithSchema(AliyunConfig, config))
  },
  scaleway: async (config) => {
    const { ScalewayVFS } = await import('./scaleway/scaleway.ts')
    const { ScalewayConfig } = await import('./scaleway/config.ts')
    return new ScalewayVFS(parseConfigWithSchema(ScalewayConfig, config))
  },
  qingstor: async (config) => {
    const { QingStorVFS } = await import('./qingstor/qingstor.ts')
    const { QingStorConfig } = await import('./qingstor/config.ts')
    return new QingStorVFS(parseConfigWithSchema(QingStorConfig, config))
  },
  postgres: async (config) => {
    const { PostgresVFS } = await import('./direct/postgres.ts')
    const { PostgresConfig } = await import('./postgres/config.ts')
    return new PostgresVFS(parseConfigWithSchema(PostgresConfig, config))
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
 * a plugin cannot replace a builtin factory.
 */
export function registerVfs(name: string, factory: VFSFactory): void {
  if (name in REGISTRY) throw new Error(`cannot register '${name}': shadows a builtin`)
  CUSTOM[name] = factory
}

/**
 * Build a VFS from one runtime's table: `builtins` win over `custom`, and
 * both over `fallback`, which builds what neither names (Node's colon
 * reference to a class) or answers null. Each runtime's `buildVfs` is this
 * over its own table, so they all resolve secrets and report a refused
 * config the same way.
 */
export async function buildVfsFrom(
  builtins: Readonly<Record<string, VFSFactory>>,
  custom: Readonly<Record<string, VFSFactory>>,
  name: string,
  config: Record<string, unknown> = {},
  sources?: Readonly<Record<string, ResolvedSource>>,
  fallback?: (name: string, config: Record<string, unknown>) => Promise<BaseVFS | null>,
): Promise<BaseVFS> {
  // A `{from, ref, key}` in the config is fetched here, before the
  // VFS's own schema parses, so every credential reaches its
  // client as the plain string it already reads. Python resolves one
  // step earlier, in its config loader (`resolve_secrets`), because
  // `build_vfs` is sync by rule there. A config with no pointer
  // does no I/O.
  const resolved = await resolveConfigSecrets(config, sources, `mounts.${name}.config`)
  const factory = builtins[name] ?? custom[name]
  let built: BaseVFS | null
  try {
    built =
      factory !== undefined
        ? await factory(resolved)
        : fallback !== undefined
          ? await fallback(name, resolved)
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
    const known = [...new Set([...Object.keys(builtins), ...Object.keys(custom)])].sort(
      compareCodePoints,
    )
    throw new Error(`unknown VFS ${JSON.stringify(name)}; known: ${known.join(', ')}`)
  }
  return built
}

/** Build a VFS by registry name from the backends core implements. */
export async function buildVfs(
  name: string,
  config: Record<string, unknown> = {},
  sources?: Readonly<Record<string, ResolvedSource>>,
): Promise<BaseVFS> {
  return buildVfsFrom(REGISTRY, CUSTOM, name, config, sources)
}
