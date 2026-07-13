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
  CommandSafeguard,
  ConsistencyPolicy,
  MountMode,
  OnExceed,
  PYTHON_RUNTIMES,
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

const VALID_CONSISTENCY = new Set<string>([ConsistencyPolicy.LAZY, ConsistencyPolicy.ALWAYS])

const VALID_PYTHON_RUNTIMES = new Set<string>(PYTHON_RUNTIMES)

function coercePythonRuntime(value: string): string {
  const lower = value.toLowerCase()
  if (!VALID_PYTHON_RUNTIMES.has(lower)) {
    if (lower === 'local') {
      throw new Error(
        "python runtime 'local' is Python-only (the host CPython subprocess); " +
          "TypeScript supports 'pyodide' (default) and 'monty'",
      )
    }
    throw new Error(`invalid python runtime: ${value} (expected 'pyodide' or 'monty')`)
  }
  return lower
}

function coerceConsistency(value: string | undefined): ConsistencyPolicy {
  if (value === undefined) return ConsistencyPolicy.LAZY
  const lower = value.toLowerCase()
  if (!VALID_CONSISTENCY.has(lower)) throw new Error(`invalid consistency: ${value}`)
  return lower as ConsistencyPolicy
}

const VALID_ON_EXCEED = new Set<string>([OnExceed.ERROR, OnExceed.TRUNCATE])

function coerceOnExceed(value: string): OnExceed {
  if (!VALID_ON_EXCEED.has(value.toLowerCase())) {
    throw new Error(`invalid onExceed: ${value}`)
  }
  return value.toLowerCase() as OnExceed
}

function snakeToCamel(key: string): string {
  let out = ''
  let upper = false
  for (const ch of key) {
    if (ch === '_') {
      upper = true
      continue
    }
    out += upper ? ch.toUpperCase() : ch
    upper = false
  }
  return out
}

function camelizeKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) out[snakeToCamel(k)] = v
  return out
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// Workspace YAML uses Python's snake_case keys (default_session_id, the
// cache/index key_prefix/max_drain_bytes, ...). TS code stays camelCase, so
// normalize at the boundary: camelize the top-level keys plus the cache and
// index blocks. Mounts are left untouched on purpose, their `config:` blocks
// carry resource credentials whose snake_case keys (aws_access_key_id, ...)
// are consumed downstream as-is, and command_safeguards is camelized later.
function normalizeConfigKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const out = camelizeKeys(raw)
  if (isPlainObject(out.cache)) out.cache = camelizeKeys(out.cache)
  if (isPlainObject(out.index)) out.index = camelizeKeys(out.index)
  return out
}

// Workspace YAML uses Python's snake_case keys (command_safeguards, max_lines,
// on_exceed, ...). The in-memory config stays camelCase, so normalize each
// block's keys at the boundary before constructing the safeguard.
function parseSafeguards(
  raw: Record<string, Record<string, unknown>> | undefined,
): Record<string, CommandSafeguard> {
  const out: Record<string, CommandSafeguard> = {}
  for (const [cmd, rawBlock] of Object.entries(raw ?? {})) {
    const block = camelizeKeys(rawBlock) as RawSafeguardBlock
    out[cmd] = new CommandSafeguard({
      ...(block.maxBytes !== undefined ? { maxBytes: block.maxBytes } : {}),
      ...(block.maxLines !== undefined ? { maxLines: block.maxLines } : {}),
      ...(block.timeoutSeconds !== undefined ? { timeoutSeconds: block.timeoutSeconds } : {}),
      ...(block.onExceed !== undefined ? { onExceed: coerceOnExceed(block.onExceed) } : {}),
    })
  }
  return out
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

interface RawSafeguardBlock {
  maxBytes?: number | null
  maxLines?: number | null
  timeoutSeconds?: number | null
  onExceed?: string
}

export interface MountBlock {
  resource: string
  mode?: string
  config?: Record<string, unknown>
  command_safeguards?: Record<string, Record<string, unknown>>
  fuse?: boolean | string
}

interface RamCacheBlock {
  type?: 'ram'
  limit?: string | number
  maxDrainBytes?: number | null
}

interface RedisCacheBlock {
  type: 'redis'
  limit?: string | number
  maxDrainBytes?: number | null
  url?: string
  keyPrefix?: string
}

interface RamIndexBlock {
  type?: 'ram'
  ttl?: number
}

interface RedisIndexBlock {
  type: 'redis'
  ttl?: number
  url?: string
  keyPrefix?: string
}

interface RuntimeBlock {
  python?: string
}

export interface WorkspaceConfigRaw {
  mounts: Record<string, MountBlock>
  runtime?: RuntimeBlock | null
  mode?: string
  consistency?: string
  defaultSessionId?: string
  defaultAgentId?: string
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
  source: Record<string, unknown>,
  env?: Record<string, string>,
): WorkspaceConfigRaw {
  const raw = { ...source }
  const useEnv = env ?? readProcessEnv()
  const interpolated = interpolateEnv(raw, useEnv)
  const normalized = normalizeConfigKeys(interpolated)
  const mounts = normalized.mounts
  if (
    mounts === undefined ||
    typeof mounts !== 'object' ||
    mounts === null ||
    Array.isArray(mounts)
  ) {
    throw new Error('config requires a `mounts` mapping')
  }
  return normalized as unknown as WorkspaceConfigRaw
}

export function loadWorkspaceConfigFile(
  path: string,
  env?: Record<string, string>,
): WorkspaceConfigRaw {
  const text = readFileSync(path, 'utf-8')
  const parsed: unknown = parseYaml(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`config source must be a mapping`)
  }
  return loadWorkspaceConfig(parsed as Record<string, unknown>, env)
}

export interface WorkspaceArgs {
  resources: Record<string, [Resource, MountMode, Record<string, CommandSafeguard>]>
  options: {
    mode: MountMode
    consistency: ConsistencyPolicy
    sessionId: string
    agentId: string
    cache?: FileCache & Resource
    index?: IndexConfig
    pythonRuntime?: string
  }
  fuseMounts: Record<string, boolean | string>
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
  const consistency = coerceConsistency(cfg.consistency)
  const resources: Record<string, [Resource, MountMode, Record<string, CommandSafeguard>]> = {}
  const fuseMounts: Record<string, boolean | string> = {}
  for (const [prefix, block] of Object.entries(cfg.mounts)) {
    const r = await buildResource(block.resource, block.config ?? {})
    const m = coerceMountMode(block.mode, wsMode)
    resources[prefix] = [r, m, parseSafeguards(block.command_safeguards)]
    if (block.fuse !== undefined && block.fuse !== false) fuseMounts[prefix] = block.fuse
  }
  const cache = buildCache(cfg.cache)
  const index = buildIndex(cfg.index)
  return {
    resources,
    options: {
      mode: wsMode,
      consistency,
      sessionId: cfg.defaultSessionId ?? 'default',
      agentId: cfg.defaultAgentId ?? 'default',
      ...(cache !== undefined ? { cache } : {}),
      ...(index !== undefined ? { index } : {}),
      ...(cfg.runtime?.python !== undefined
        ? { pythonRuntime: coercePythonRuntime(cfg.runtime.python) }
        : {}),
    },
    fuseMounts,
  }
}
