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

import type { ResolvedSource } from '@struktoai/mirage-core/secrets/types'
import { normalizeFields } from '@struktoai/mirage-core/utils/normalize'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import { type BaseVFS, VFS_BRAND } from '@struktoai/mirage-core/vfs/base'
import {
  buildVfsFrom,
  DIRECT_REGISTRY,
  REGISTRY as CORE_REGISTRY,
  type VFSFactory,
} from '@struktoai/mirage-core/vfs/registry'
import { parseConfigWithSchema, refuseUnknownKeys } from '@struktoai/mirage-core/vfs/secrets'
import { loadAttr } from '../utils/loader.ts'
import type { DiskVFSOptions } from './disk/disk.ts'
import type { RedisVFSOptions } from './redis/redis.ts'
import './s3/s3.ts'

// The backends that take their options without a schema, and the option
// names each takes. Python builds them from constructor keywords,
// so a key outside these is refused on both sides rather than ignored here.
const DISK_OPTIONS: readonly (keyof DiskVFSOptions)[] = ['root', 'folderVersions', 'capacity']
const REDIS_OPTIONS: readonly (keyof RedisVFSOptions)[] = ['url', 'keyPrefix', 'capacity']

/**
 * Node's VFS table: the backends core implements (`REGISTRY` in
 * `@struktoai/mirage-core/vfs/registry`), the ones core wires for a host
 * that holds their credential (`DIRECT_REGISTRY`), and the ones this
 * package implements for Node. Mirrors Python's `mirage.vfs.registry.build_vfs`.
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
const REGISTRY: Record<string, VFSFactory> = {
  ...CORE_REGISTRY,
  ...DIRECT_REGISTRY,
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
  gridfs: async (config) => {
    const { GridFSVFS } = await import('./gridfs/gridfs.ts')
    const { normalizeGridFSConfig } = await import('./gridfs/config.ts')
    return new GridFSVFS(normalizeGridFSConfig(config))
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
  mongodb: async (config) => {
    const { MongoDBVFS } = await import('./mongodb/mongodb.ts')
    const { MongoDBConfig } = await import('@struktoai/mirage-core/vfs/mongodb/config')
    return new MongoDBVFS(parseConfigWithSchema(MongoDBConfig, config))
  },
  lancedb: async (config) => {
    const { LanceDBVFS } = await import('./lancedb/lancedb.ts')
    const { LanceDBConfig } = await import('@struktoai/mirage-core/vfs/lancedb/config')
    return new LanceDBVFS(parseConfigWithSchema(LanceDBConfig, config))
  },
  ssh: async (config) => {
    const { SSHVFS } = await import('./ssh/ssh.ts')
    const { SSHConfig } = await import('./ssh/config.ts')
    return new SSHVFS(parseConfigWithSchema(SSHConfig, config))
  },
  nextcloud: async (config) => {
    const { NextcloudVFS } = await import('./nextcloud/nextcloud.ts')
    const { NextcloudConfig } = await import('./nextcloud/config.ts')
    return new NextcloudVFS(parseConfigWithSchema(NextcloudConfig, config))
  },
  email: async (config) => {
    const { EmailVFS } = await import('./email/email.ts')
    const { EmailConfig } = await import('../core/email/config.ts')
    return new EmailVFS(parseConfigWithSchema(EmailConfig, config))
  },
}

export type { VFSFactory }

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
  return buildVfsFrom(REGISTRY, CUSTOM, name, config, sources, (unknown, resolved) =>
    unknown.includes(':') ? buildFromRef(unknown, resolved) : Promise.resolve(null),
  )
}
