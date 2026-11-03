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
 * with neither (a Cloudflare Worker) builds from this one alone.
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
