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

import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import {
  buildResource,
  MountMode,
  RAMFileCacheStore,
  RedisFileCacheStore,
  type FileCache,
  type IndexConfig,
  type RedisIndexConfig,
  type Resource,
} from '@struktoai/mirage-node'

const VALID_MODES = new Set<string>([MountMode.READ, MountMode.WRITE, MountMode.EXEC])

function coerceMountMode(value: string | undefined, fallback: MountMode): MountMode {
  if (value === undefined) return fallback
  const lower = value.toLowerCase()
  if (!VALID_MODES.has(lower)) throw new Error(`invalid mount mode: ${value}`)
  return lower as MountMode
}

const VAR_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g

function walkInterpolate(v: unknown, env: Record<string, string>, missing: string[]): unknown {
  if (typeof v === 'string') {
    return v.replace(VAR_RE, (_m, name: string) => {
      const resolved = env[name]
      if (resolved === undefined) {
        missing.push(name)
        return ''
      }
      return resolved
    })
  }
  if (Array.isArray(v)) {
    return v.map((item) => walkInterpolate(item, env, missing))
  }
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = walkInterpolate(val, env, missing)
    }
    return out
  }
  return v
}

export function interpolateEnv<T>(value: T, env: Record<string, string>): T {
  const missing: string[] = []
  const out = walkInterpolate(value, env, missing)
  if (missing.length > 0) {
    const unique = Array.from(new Set(missing)).sort()
    throw new Error(`missing environment variables: ${unique.join(', ')}`)
  }
  return out as T
}

export interface MountBlock {
  resource: string
  mode?: string
  config?: Record<string, unknown>
}

export interface RamCacheBlock {
  type?: 'ram'
  limit?: string | number
  maxDrainBytes?: number | null
}

export interface RedisCacheBlock {
  type: 'redis'
  limit?: string | number
  maxDrainBytes?: number | null
  url?: string
  keyPrefix?: string
}

export interface RamIndexBlock {
  type?: 'ram'
  ttl?: number
}

export interface RedisIndexBlock {
  type: 'redis'
  ttl?: number
  url?: string
  keyPrefix?: string
}

export interface WorkspaceConfigRaw {
  mounts: Record<string, MountBlock>
  mode?: string
  consistency?: string
  defaultSessionId?: string
  defaultAgentId?: string
  history?: number | null
  fuse?: boolean
  cache?: RamCacheBlock | RedisCacheBlock | null
  index?: RamIndexBlock | RedisIndexBlock | null
}

function readProcessEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

export function loadWorkspaceConfig(
  source: string | Record<string, unknown>,
  env?: Record<string, string>,
): WorkspaceConfigRaw {
  let raw: Record<string, unknown>
  if (typeof source === 'string') {
    const text = readFileSync(source, 'utf-8')
    const parsed: unknown = parseYaml(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`config source must be a mapping`)
    }
    raw = parsed as Record<string, unknown>
  } else {
    raw = { ...source }
  }
  const useEnv = env ?? readProcessEnv()
  const interpolated = interpolateEnv(raw, useEnv)
  const mounts = interpolated.mounts
  if (
    mounts === undefined ||
    typeof mounts !== 'object' ||
    mounts === null ||
    Array.isArray(mounts)
  ) {
    throw new Error('config requires a `mounts` mapping')
  }
  return interpolated as unknown as WorkspaceConfigRaw
}

export interface WorkspaceArgs {
  resources: Record<string, [Resource, MountMode]>
  options: {
    mode: MountMode
    sessionId: string
    agentId: string
    cache?: FileCache & Resource
    index?: IndexConfig
  }
}

function buildCache(
  block: RamCacheBlock | RedisCacheBlock | null | undefined,
): (FileCache & Resource) | undefined {
  if (block === null || block === undefined) return undefined
  if (block.type === 'redis') {
    return new RedisFileCacheStore({
      ...(block.limit !== undefined ? { cacheLimit: block.limit } : {}),
      ...(block.maxDrainBytes !== undefined ? { maxDrainBytes: block.maxDrainBytes } : {}),
      ...(block.url !== undefined ? { url: block.url } : {}),
      ...(block.keyPrefix !== undefined ? { keyPrefix: block.keyPrefix } : {}),
    })
  }
  return new RAMFileCacheStore({
    ...(block.limit !== undefined ? { limit: block.limit } : {}),
    ...(block.maxDrainBytes !== undefined ? { maxDrainBytes: block.maxDrainBytes } : {}),
  })
}

function buildIndex(
  block: RamIndexBlock | RedisIndexBlock | null | undefined,
): IndexConfig | undefined {
  if (block === null || block === undefined) return undefined
  if (block.type === 'redis') {
    const cfg: RedisIndexConfig = { type: 'redis' }
    if (block.ttl !== undefined) cfg.ttl = block.ttl
    if (block.url !== undefined) cfg.url = block.url
    if (block.keyPrefix !== undefined) cfg.keyPrefix = block.keyPrefix
    return cfg
  }
  const cfg: IndexConfig = { type: 'ram' }
  if (block.ttl !== undefined) cfg.ttl = block.ttl
  return cfg
}

export async function configToWorkspaceArgs(cfg: WorkspaceConfigRaw): Promise<WorkspaceArgs> {
  const wsMode = coerceMountMode(cfg.mode, MountMode.WRITE)
  const resources: Record<string, [Resource, MountMode]> = {}
  for (const [prefix, block] of Object.entries(cfg.mounts)) {
    const r = await buildResource(block.resource, block.config ?? {})
    const m = coerceMountMode(block.mode, wsMode)
    resources[prefix] = [r, m]
  }
  const cache = buildCache(cfg.cache)
  const index = buildIndex(cfg.index)
  return {
    resources,
    options: {
      mode: wsMode,
      sessionId: cfg.defaultSessionId ?? 'default',
      agentId: cfg.defaultAgentId ?? 'default',
      ...(cache !== undefined ? { cache } : {}),
      ...(index !== undefined ? { index } : {}),
    },
  }
}
