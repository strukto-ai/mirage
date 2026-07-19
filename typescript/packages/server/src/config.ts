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
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  buildResource,
  CommandSafeguard,
  ConsistencyPolicy,
  ScriptSource,
  MountMode,
  OnExceed,
  RAMFileCacheStore,
  RAMWorkspaceStateStore,
  RedisFileCacheStore,
  RedisWorkspaceStateStore,
  buildRuntime,
  type RuntimeEntry,
  type FileCache,
  type IndexConfig,
  type RedisIndexConfig,
  type Resource,
  type WorkspaceStateStore,
} from '@struktoai/mirage-node'

const VALID_MODES = new Set<string>([MountMode.READ, MountMode.WRITE, MountMode.EXEC])

function coerceMountMode(value: string | undefined, fallback: MountMode): MountMode {
  if (value === undefined) return fallback
  const lower = value.toLowerCase()
  if (!VALID_MODES.has(lower)) throw new Error(`invalid mount mode: ${value}`)
  return lower as MountMode
}

const VALID_CONSISTENCY = new Set<string>([ConsistencyPolicy.LAZY, ConsistencyPolicy.ALWAYS])

/** True for the docker-style single-line `.py` path form. */
function isScriptPath(value: string): boolean {
  return !value.includes('\n') && value.trim().endsWith('.py')
}

// Config carries a reference, the wire carries content (the docker
// build-context model): the value must be a path to a .py file, read
// at load time. In code, scripts are functions; config is the only
// door for script source.
function loadScriptSource(value: string): ScriptSource {
  if (!isScriptPath(value)) {
    throw new Error(
      `a config script must reference a .py file (e.g. script: guard.py), got '${value}'`,
    )
  }
  return new ScriptSource(readFileSync(value.trim(), 'utf-8'))
}

function buildRuntimeEntries(entries: unknown[]): RuntimeEntry[] {
  const out: RuntimeEntry[] = []
  for (const entry of entries) {
    if (typeof entry === 'string') {
      out.push(buildRuntime(entry))
      continue
    }
    if (!isPlainObject(entry)) throw new Error('runtime entry must be a name or a mapping')
    const { name, script, ...options } = entry
    if (typeof name !== 'string' || name === '') {
      throw new Error("runtime entry needs a non-empty 'name'")
    }
    if (script !== undefined && typeof script !== 'string') {
      throw new Error('a runtime entry script must be a .py path string')
    }
    const built = buildRuntime(name, options)
    if (script !== undefined) built.script = loadScriptSource(script)
    out.push(built)
  }
  return out
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
  if (isPlainObject(out.store)) {
    const store = camelizeKeys(out.store)
    for (const group of ['namespace', 'observer', 'workspace']) {
      if (isPlainObject(store[group])) {
        store[group] = camelizeKeys(store[group])
      }
    }
    out.store = store
  }
  if (Array.isArray(out.runtimes)) {
    out.runtimes = out.runtimes.map((entry): unknown =>
      isPlainObject(entry) ? camelizeKeys(entry) : entry,
    )
  }
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

interface RamStoreGroupBlock {
  type?: 'ram'
}

interface RedisStoreGroupBlock {
  type: 'redis'
  url?: string
  keyPrefix?: string
}

type StoreGroupBlock = RamStoreGroupBlock | RedisStoreGroupBlock

/**
 * The workspace state store: one block, four planes. The top-level
 * type/url/keyPrefix pick the default backend for every control-plane
 * group (namespace nodes, observer events, sessions + workspace
 * metadata); the optional per-group overrides redirect one group to a
 * different backend. Sessions and workspace metadata move together by
 * design, so there is one `workspace` override, not two.
 */
interface StoreBlock {
  type?: 'ram' | 'redis'
  url?: string
  keyPrefix?: string
  namespace?: StoreGroupBlock | null
  observer?: StoreGroupBlock | null
  workspace?: StoreGroupBlock | null
}

export interface WorkspaceConfigRaw {
  mounts: Record<string, MountBlock>
  runtimes?: (string | Record<string, unknown>)[] | null
  route?: string | null
  mode?: string
  consistency?: string
  defaultSessionId?: string
  defaultAgentId?: string
  workspaceId?: string
  cache?: RamCacheBlock | RedisCacheBlock | null
  index?: RamIndexBlock | RedisIndexBlock | null
  store?: StoreBlock | null
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

/**
 * Resolve relative script paths against the config file's directory.
 *
 * A path-form `script`/`route` in a config file means "next to the
 * file" (the docker build-context model), never "wherever the server
 * happens to run". In-memory object configs are untouched.
 */
function absolutizeScripts(raw: WorkspaceConfigRaw, base: string): void {
  const route = raw.route
  if (typeof route === 'string' && isScriptPath(route) && !isAbsolute(route.trim())) {
    raw.route = join(base, route.trim())
  }
  if (!Array.isArray(raw.runtimes)) return
  for (const entry of raw.runtimes) {
    if (typeof entry === 'string') continue
    const script = entry.script
    if (typeof script === 'string' && isScriptPath(script) && !isAbsolute(script.trim())) {
      entry.script = join(base, script.trim())
    }
  }
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
  const config = loadWorkspaceConfig(parsed as Record<string, unknown>, env)
  absolutizeScripts(config, dirname(resolve(path)))
  return config
}

export interface WorkspaceArgs {
  resources: Record<string, [Resource, MountMode, Record<string, CommandSafeguard>]>
  options: {
    mode: MountMode
    consistency: ConsistencyPolicy
    sessionId?: string
    agentId?: string
    cache?: FileCache & Resource
    index?: IndexConfig
    workspaceId?: string
    store?: WorkspaceStateStore
    runtimes?: RuntimeEntry[]
    route?: ScriptSource
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

function buildStoreGroup(block: StoreGroupBlock): WorkspaceStateStore {
  if (block.type === 'redis') {
    return new RedisWorkspaceStateStore({
      ...(block.url !== undefined ? { url: block.url } : {}),
      ...(block.keyPrefix !== undefined ? { keyPrefix: block.keyPrefix } : {}),
    })
  }
  return new RAMWorkspaceStateStore()
}

function buildStateStore(block: StoreBlock | null | undefined): WorkspaceStateStore | undefined {
  if (block === null || block === undefined) return undefined
  const overrides = {
    ...(block.namespace != null ? { namespace: buildStoreGroup(block.namespace) } : {}),
    ...(block.observer != null ? { observer: buildStoreGroup(block.observer) } : {}),
    ...(block.workspace != null ? { workspace: buildStoreGroup(block.workspace) } : {}),
  }
  if (block.type === 'redis') {
    return new RedisWorkspaceStateStore({
      ...(block.url !== undefined ? { url: block.url } : {}),
      ...(block.keyPrefix !== undefined ? { keyPrefix: block.keyPrefix } : {}),
      ...overrides,
    })
  }
  return new RAMWorkspaceStateStore(overrides)
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
  const stateStore = buildStateStore(cfg.store)
  return {
    resources,
    options: {
      mode: wsMode,
      consistency,
      ...(cfg.defaultSessionId !== undefined ? { sessionId: cfg.defaultSessionId } : {}),
      ...(cfg.defaultAgentId !== undefined ? { agentId: cfg.defaultAgentId } : {}),
      ...(cfg.workspaceId !== undefined ? { workspaceId: cfg.workspaceId } : {}),
      ...(cache !== undefined ? { cache } : {}),
      ...(index !== undefined ? { index } : {}),
      ...(stateStore !== undefined ? { store: stateStore } : {}),
      ...(cfg.runtimes !== undefined && cfg.runtimes !== null
        ? { runtimes: buildRuntimeEntries(cfg.runtimes) }
        : {}),
      ...(cfg.route !== undefined && cfg.route !== null
        ? { route: loadScriptSource(cfg.route) }
        : {}),
    },
    fuseMounts,
  }
}
