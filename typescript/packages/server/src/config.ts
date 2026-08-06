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
  CLISpec,
  Limit,
  ConsistencyPolicy,
  KERNEL_BACKENDS,
  MountBackend,
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
  type GuardSpec,
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

/** True for the docker-style single-line script path form (.py/.js/.mjs). */
function isScriptPath(value: string): boolean {
  return !value.includes('\n') && ['.py', '.js', '.mjs'].some((ext) => value.trim().endsWith(ext))
}

// Config carries a reference, the wire carries content (the docker
// build-context model): the value must be a path to a .py/.js file,
// read at load time. In code, scripts are functions; config is the
// only door for script source. The extension stamps the script's
// language so the policy engine can pick a matching evaluator.
function loadScriptSource(value: string): ScriptSource {
  if (!isScriptPath(value)) {
    throw new Error(
      `a config script must reference a .py/.js file (e.g. script: guard.py), got '${value}'`,
    )
  }
  const path = value.trim()
  const language = path.endsWith('.js') || path.endsWith('.mjs') ? 'js' : 'python'
  return new ScriptSource(readFileSync(path, 'utf-8'), language, path.endsWith('.mjs'))
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
    const withScript: Record<string, unknown> =
      script !== undefined ? { ...options, script: loadScriptSource(script) } : options
    out.push(buildRuntime(name, withScript))
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
// are consumed downstream as-is, and command_limits is camelized later.
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
    // A runtime entry's config block carries the runtime's own knobs
    // (sandbox_id, api_key, home, ...), snake_case in yaml like every
    // Python-shaped key; the TS runtime config classes are camelCase,
    // so camelize the block's keys too. Only the keys: values such as
    // the env map pass through untouched.
    out.runtimes = out.runtimes.map((entry): unknown => {
      if (!isPlainObject(entry)) return entry
      const normalized = camelizeKeys(entry)
      if (isPlainObject(normalized.config)) {
        normalized.config = camelizeKeys(normalized.config)
      }
      return normalized
    })
  }
  return out
}

// Workspace YAML uses Python's snake_case keys (command_limits, max_lines,
// on_exceed, ...). The in-memory config stays camelCase, so normalize each
// block's keys at the boundary before constructing the limit.
function parseLimits(
  raw: Record<string, Record<string, unknown>> | undefined,
): Record<string, Limit> {
  const out: Record<string, Limit> = {}
  for (const [cmd, rawBlock] of Object.entries(raw ?? {})) {
    const block = camelizeKeys(rawBlock) as RawLimitBlock
    out[cmd] = new Limit({
      ...(block.maxBytes !== undefined ? { maxBytes: block.maxBytes } : {}),
      ...(block.maxLines !== undefined ? { maxLines: block.maxLines } : {}),
      ...(block.timeoutSeconds !== undefined ? { timeoutSeconds: block.timeoutSeconds } : {}),
      ...(block.onExceed !== undefined ? { onExceed: coerceOnExceed(block.onExceed) } : {}),
    })
  }
  return out
}

// Mirrors Python's GuardBlock: reason is required, commands/paths are
// optional string lists. Compiled by the workspace into declarative
// admission policies (see core policy/spec.ts).
function parseGuards(entries: unknown): GuardSpec[] {
  if (!Array.isArray(entries)) throw new Error('config `guards` must be a list')
  return entries.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('each guard must be a mapping with a `reason`')
    }
    const block = entry as Record<string, unknown>
    // Mirror Python's extra="forbid": a typo like `path:` silently
    // widening the guard into an unconditional denial must fail loud.
    for (const key of Object.keys(block)) {
      if (key !== 'reason' && key !== 'commands' && key !== 'paths') {
        throw new Error(`unknown guard key \`${key}\` (allowed: reason, commands, paths)`)
      }
    }
    const reason = block.reason
    if (typeof reason !== 'string' || reason === '') {
      throw new Error('each guard needs a non-empty string `reason`')
    }
    for (const key of ['commands', 'paths']) {
      const v = block[key]
      if (v !== undefined && (!Array.isArray(v) || v.some((s) => typeof s !== 'string'))) {
        throw new Error(`guard \`${key}\` must be a list of strings`)
      }
    }
    return {
      reason,
      ...(block.commands !== undefined ? { commands: block.commands as string[] } : {}),
      ...(block.paths !== undefined ? { paths: block.paths as string[] } : {}),
    }
  })
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

interface RawLimitBlock {
  maxBytes?: number | null
  maxLines?: number | null
  timeoutSeconds?: number | null
  onExceed?: string
}

export interface MountBlock {
  resource: string
  mode?: string
  config?: Record<string, unknown>
  command_limits?: Record<string, Record<string, unknown>>
  /** vfs (default), fuse, or fskit. Mirrors Python's MountBlock.backend. */
  backend?: string
  mountpoint?: string
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

/**
 * One `clis:` entry: install a named CLISpec with its own config. The
 * section key is the installed head word. Exactly one handler source:
 * `cli` names a registered spec tree; `script` references a program
 * file whose content is embedded at load (the docker build-context
 * model). `runtime` optionally pins the world runtime entry that runs
 * the script; unset picks the first entry speaking the script's
 * language. `config` validates through the spec's configModel at
 * install time (fail loud). A CLI never takes a mode and never shares
 * a mount's credentials: a binary has no mode, the credential does.
 */
interface CLIBlock {
  cli?: string
  script?: string
  runtime?: string
  config?: Record<string, unknown>
}

export interface WorkspaceConfigRaw {
  mounts: Record<string, MountBlock>
  clis?: Record<string, CLIBlock> | null
  runtimes?: (string | Record<string, unknown>)[] | null
  policy?: string | null
  guards?: unknown[] | null
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
 * A path-form `script`/`policy` in a config file means "next to the
 * file" (the docker build-context model), never "wherever the server
 * happens to run". In-memory object configs are untouched.
 */
function absolutizeScripts(raw: WorkspaceConfigRaw, base: string): void {
  const policy = raw.policy
  if (typeof policy === 'string' && isScriptPath(policy) && !isAbsolute(policy.trim())) {
    raw.policy = join(base, policy.trim())
  }
  if (Array.isArray(raw.runtimes)) {
    for (const entry of raw.runtimes) {
      if (typeof entry !== 'string') absolutizeScriptKey(entry, base)
    }
  }
  if (raw.clis !== undefined && raw.clis !== null) {
    for (const block of Object.values(raw.clis)) {
      absolutizeScriptKey(block as Record<string, unknown>, base)
    }
  }
}

/** Rebase one runtimes/clis entry's relative `script` path onto `base`. */
function absolutizeScriptKey(entry: Record<string, unknown>, base: string): void {
  const script = entry.script
  if (typeof script === 'string' && isScriptPath(script) && !isAbsolute(script.trim())) {
    entry.script = join(base, script.trim())
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
  resources: Record<string, [Resource, MountMode, Record<string, Limit>]>
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
    policy?: ScriptSource
    guards?: GuardSpec[]
    clis?: Record<string, [string | CLISpec, Record<string, unknown> | null]>
  }
  kernelMounts: Record<string, [MountBackend, string | undefined]>
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
  const resources: Record<string, [Resource, MountMode, Record<string, Limit>]> = {}
  const kernelMounts: Record<string, [MountBackend, string | undefined]> = {}
  for (const [prefix, block] of Object.entries(cfg.mounts)) {
    const r = await buildResource(block.resource, block.config ?? {})
    const m = coerceMountMode(block.mode, wsMode)
    resources[prefix] = [r, m, parseLimits(block.command_limits)]
    const backend = (block.backend ?? MountBackend.VFS) as MountBackend
    if (KERNEL_BACKENDS.includes(backend)) kernelMounts[prefix] = [backend, block.mountpoint]
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
      ...(cfg.policy !== undefined && cfg.policy !== null
        ? { policy: loadScriptSource(cfg.policy) }
        : {}),
      ...(cfg.guards !== undefined && cfg.guards !== null
        ? { guards: parseGuards(cfg.guards) }
        : {}),
      ...(cfg.clis !== undefined && cfg.clis !== null ? { clis: buildCliEntries(cfg.clis) } : {}),
    },
    kernelMounts,
  }
}

function buildCliEntries(
  clis: Record<string, CLIBlock>,
): Record<string, [string | CLISpec, Record<string, unknown> | null]> {
  const out: Record<string, [string | CLISpec, Record<string, unknown> | null]> = {}
  const known = new Set(['cli', 'script', 'runtime', 'config'])
  for (const [name, block] of Object.entries(clis as Record<string, unknown>)) {
    // The raw config arrives as unvalidated YAML: the CLIBlock type is
    // a claim, not a guarantee, so validate the shape here.
    if (!isPlainObject(block)) {
      throw new Error(`clis entry '${name}' must be a mapping`)
    }
    const unknown = Object.keys(block).filter((k) => !known.has(k))
    if (unknown.length > 0) {
      throw new Error(`clis entry '${name}': unknown keys: ${unknown.sort().join(', ')}`)
    }
    const hasCli = typeof block.cli === 'string'
    const hasScript = typeof block.script === 'string'
    if (hasCli === hasScript) {
      throw new Error(`clis entry '${name}' takes exactly one of cli or script`)
    }
    if (block.runtime !== undefined && !hasScript) {
      throw new Error(`clis entry '${name}': runtime pins the script's runtime; it takes script`)
    }
    if (block.runtime !== undefined && typeof block.runtime !== 'string') {
      throw new Error(`clis entry '${name}': runtime must be a string`)
    }
    if (block.config !== undefined && !isPlainObject(block.config)) {
      throw new Error(`clis entry '${name}': config must be a mapping`)
    }
    const entry = hasScript
      ? new CLISpec({
          name,
          script: loadScriptSource(block.script as string),
          runtime: block.runtime ?? null,
        })
      : (block.cli as string)
    out[name] = [entry, block.config ?? {}]
  }
  return out
}
