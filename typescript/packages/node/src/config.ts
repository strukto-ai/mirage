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

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { CacheConfig } from '@struktoai/mirage-core/cache/file/config'
import type { IndexConfig, RedisIndexConfig } from '@struktoai/mirage-core/cache/index/config'
import { CLISpec } from '@struktoai/mirage-core/commands/cli/types'
import type { Resource } from '@struktoai/mirage-core/resource/base'
import type { RuntimeEntry } from '@struktoai/mirage-core/runtime/base'
import { ScriptSource } from '@struktoai/mirage-core/runtime/routing/index'
import { buildRuntime } from '@struktoai/mirage-core/runtime/table'
import {
  EnvVarSchema,
  SecretSourceSchema,
  type EnvEntries,
  type SecretEntries,
} from '@struktoai/mirage-core/secrets/config'
import {
  ConsistencyPolicy,
  KERNEL_BACKENDS,
  Limit,
  MountBackend,
  MountMode,
  OnExceed,
  parseMountMode,
} from '@struktoai/mirage-core/types'
import { snakeToCamel } from '@struktoai/mirage-core/utils/normalize'
import { parseSessionProfile, type SessionProfile } from '@struktoai/mirage-core/policy/profile'
import type { ResolvedSource } from '@struktoai/mirage-core/secrets/types'
import type { WorkspaceStateStore } from '@struktoai/mirage-core/workspace/store/base'
import { RAMWorkspaceStateStore } from '@struktoai/mirage-core/workspace/store/ram'
import { S3WorkspaceStateStore } from '@struktoai/mirage-core/workspace/store/s3'
import type { WorkspaceOptions } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { normalizeS3Config } from './resource/s3/config.ts'
import { isModulePath, loadAttr, splitRef } from './resource/loader.ts'
// The config door is a workspace entry point of its own (the daemon
// builds from here), so it arms the builtin secrets sources like the
// node Workspace module does.
import {
  configHoldsPointer,
  resolveConfigSecrets,
  resolveSourcesFor,
} from '@struktoai/mirage-core/secrets/sources'
import './secrets/constants.ts'
import { buildResource } from './resource/registry.ts'
import { RedisConsoleStore } from './shell/console/redis/index.ts'
import { DiskWorkspaceStateStore } from './workspace/store/disk.ts'
import { RedisWorkspaceStateStore } from './workspace/store/redis.ts'
import type { S3Config } from './resource/s3/config.ts'
import { JobConsole } from '@struktoai/mirage-core/shell/console/index'
import type { ConsoleFactory } from '@struktoai/mirage-core/shell/job_table/index'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'

function coerceMountMode(value: string | undefined, fallback: MountMode): MountMode {
  if (value === undefined) return fallback
  return parseMountMode(value.toLowerCase())
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

function camelizeKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) out[snakeToCamel(k)] = v
  return out
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// Python sets extra="forbid" on every workspace-config block, so a typo
// like `mount_point:` for `mountpoint:`, `consistancy:` or `limitt:` is
// a hard ValueError there. These tables mirror those models field for
// field so the same YAML is accepted (and rejected) by both languages.
//
// The spellings are Python's canonical snake_case ones on purpose: a
// camelCase alias that TS would accept for free is a key Python rejects,
// which is the same portability break pointing the other way.
//
// `mounts.*.config` is the one block with no table, because Python types
// it as a bare dict and validates it in the resource's own model. Do not
// generalize that to every credential-carrying block: an s3 store group
// has a strict Python model (`S3StoreBlock`, extra="forbid"), so it is
// tabled here like the rest.
const TOP_LEVEL_KEYS = [
  'mounts',
  'clis',
  'runtimes',
  'route_policy',
  'profiles',
  'profile',
  'mode',
  'consistency',
  'default_session_id',
  'default_agent_id',
  'workspace_id',
  'cache',
  'index',
  'store',
  'console',
  'env',
  'secrets',
] as const
const MOUNT_KEYS = [
  'resource',
  'mode',
  'config',
  'command_limits',
  'backend',
  'mountpoint',
] as const
// A source instance is a type beside a config, the way a mount is. Its
// `config:` block has no table for the same reason `mounts.*.config`
// has none: each source owns its own model and validates there.
const SOURCE_KEYS = ['source', 'config'] as const
const CACHE_KEYS: Record<string, readonly string[]> = {
  ram: ['type', 'limit', 'max_drain_bytes'],
  redis: ['type', 'limit', 'max_drain_bytes', 'url', 'key_prefix'],
}
const INDEX_KEYS: Record<string, readonly string[]> = {
  ram: ['type', 'ttl'],
  redis: ['type', 'ttl', 'url', 'key_prefix'],
}
const CONSOLE_KEYS: Record<string, readonly string[]> = {
  ram: ['type'],
  redis: ['type', 'url', 'key_prefix', 'ttl_seconds'],
}
const STORE_GROUPS = ['namespace', 'observer', 'workspace'] as const
const STORE_KEYS = ['type', 'url', 'key_prefix', 'root', ...STORE_GROUPS] as const
// An s3 group IS `S3Config` plus the discriminator, so its keys are that
// model's, spelled Python's way. Python declares it as
// `S3StoreBlock(S3Config)` with extra="forbid" — a strict model, unlike
// the untyped `mounts.*.config` — so a typo is a load error there and
// must be one here.
const STORE_GROUP_KEYS: Record<string, readonly string[]> = {
  ram: ['type'],
  disk: ['type', 'root'],
  redis: ['type', 'url', 'key_prefix'],
  s3: [
    'type',
    'bucket',
    'region',
    'endpoint_url',
    'aws_access_key_id',
    'aws_secret_access_key',
    'aws_session_token',
    'aws_profile',
    'path_style',
    'timeout',
    'proxy',
    'key_prefix',
  ],
}
// The s3 store hosts only the sessions+meta plane, so it is valid as the
// `workspace` override and nowhere else — as the top-level default it is
// already refused above. Its store raises when asked to build another
// plane; both languages now refuse the config instead of the plane.
const S3_HOSTED_GROUP = 'workspace'
const PLAIN_STORE_GROUP_KEYS: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(STORE_GROUP_KEYS).filter(([type]) => type !== 's3'),
)
const CLI_KEYS: readonly string[] = ['cli', 'script', 'runtime', 'config']

// A store group whose `type` names a backend carries that backend's own
// spellings: `aws_access_key_id` is `accessKeyId`, not `awsAccessKeyId`,
// so camelizing here would hide the key from the translation that does
// know it. Its *keys* are still checked — the backend's model declares
// them (see STORE_GROUP_KEYS above) — only the renaming is skipped.
const BACKEND_SPELLED_TYPES: ReadonlySet<string> = new Set(['s3'])

function keepsBackendSpellings(block: Record<string, unknown>): boolean {
  return typeof block.type === 'string' && BACKEND_SPELLED_TYPES.has(block.type)
}

function rejectUnknownKeys(
  block: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
): void {
  for (const key of Object.keys(block)) {
    if (allowed.includes(key)) continue
    throw new Error(`unknown ${what} key \`${key}\` (allowed: ${allowed.join(', ')})`)
  }
}

/**
 * The `type:` discriminator of a typed block. `fallback` is the type
 * assumed when the key is absent; leave it out where Python models the
 * block as a discriminated union, which makes `type` mandatory.
 */
function blockType(
  block: Record<string, unknown>,
  what: string,
  known: readonly string[],
  fallback?: string,
): string {
  const type = block.type ?? fallback
  if (type === undefined) {
    throw new Error(`config \`${what}\` needs a \`type\` (one of ${known.join(', ')})`)
  }
  if (typeof type !== 'string') {
    throw new Error(`config \`${what}\` type must be a string (one of ${known.join(', ')})`)
  }
  if (!known.includes(type)) {
    throw new Error(`unknown ${what} type \`${type}\` (expected one of ${known.join(', ')})`)
  }
  return type
}

function validateTypedBlock(
  value: unknown,
  table: Record<string, readonly string[]>,
  what: string,
  fallback?: string,
): void {
  if (value === undefined || value === null) return
  if (!isPlainObject(value)) throw new Error(`config \`${what}\` must be a mapping`)
  const type = blockType(value, what, Object.keys(table), fallback)
  rejectUnknownKeys(value, table[type] ?? [], `${what} (${type})`)
}

// Key names alone are not enough here: Python's Pydantic model rejects
// `url: 123` at load, so the TS loader must refuse the same file at the
// same boundary instead of deferring it to Redis client creation.
function validateConsoleValues(value: unknown): void {
  if (!isPlainObject(value)) return
  if (value.url !== undefined && typeof value.url !== 'string') {
    throw new Error('config `console.url` must be a string')
  }
  if (value.key_prefix !== undefined && typeof value.key_prefix !== 'string') {
    throw new Error('config `console.key_prefix` must be a string')
  }
  const ttl = value.ttl_seconds
  if (
    ttl !== undefined &&
    ttl !== null &&
    !(typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0)
  ) {
    throw new Error('config `console.ttl_seconds` must be a positive number or null')
  }
}

function validateStoreBlock(value: unknown): void {
  if (value === undefined || value === null) return
  if (!isPlainObject(value)) throw new Error('config `store` must be a mapping')
  // The top level picks the default backend for every plane; s3 hosts
  // only the sessions+meta group, so it is a `workspace` override and
  // never the default. Mirrors Python's StoreBlock.
  blockType(value, 'store', ['ram', 'disk', 'redis'], 'ram')
  rejectUnknownKeys(value, STORE_KEYS, 'store')
  for (const group of STORE_GROUPS) {
    const block = value[group]
    if (block === undefined || block === null) continue
    if (!isPlainObject(block)) throw new Error(`config \`store.${group}\` must be a mapping`)
    if (block.type === 's3' && group !== S3_HOSTED_GROUP) {
      throw new Error(
        `config \`store.${group}\` cannot be s3: the s3 store hosts only the ` +
          `sessions+meta group; keep the ${group} plane on ram or redis and pass ` +
          `the s3 store as the '${S3_HOSTED_GROUP}' group override`,
      )
    }
    const table = group === S3_HOSTED_GROUP ? STORE_GROUP_KEYS : PLAIN_STORE_GROUP_KEYS
    validateTypedBlock(block, table, `store.${group}`, 'ram')
  }
}

/** A raw block's `config`, or an empty mapping when it is absent or not one. */
function asConfig(value: unknown): Readonly<Record<string, unknown>> {
  return isPlainObject(value) ? value : {}
}

/**
 * Reject any key no Python config model declares, before normalization
 * folds snake_case into camelCase and the distinction is gone.
 */
function validateConfigKeys(raw: Record<string, unknown>): void {
  rejectUnknownKeys(raw, TOP_LEVEL_KEYS, 'config')
  if (isPlainObject(raw.mounts)) {
    for (const [prefix, block] of Object.entries(raw.mounts)) {
      if (!isPlainObject(block)) throw new Error(`mount \`${prefix}\` must be a mapping`)
      rejectUnknownKeys(block, MOUNT_KEYS, `mount \`${prefix}\``)
    }
  }
  if (isPlainObject(raw.clis)) {
    for (const [name, block] of Object.entries(raw.clis)) {
      if (!isPlainObject(block)) throw new Error(`cli \`${name}\` must be a mapping`)
      rejectUnknownKeys(block, CLI_KEYS, `cli \`${name}\``)
      // A pointer may only fill a config that a model validates, because
      // the model is what a snapshot redacts by. A script's config is
      // opaque: nothing declares which key is a credential, so the
      // snapshot captures it verbatim, and a pointer resolved into it
      // would be written out as the value it fetched. Refused here, on
      // the block, so every door that reads a config inherits the rule.
      if (typeof block.script === 'string' && configHoldsPointer(asConfig(block.config))) {
        throw new Error(
          `clis entry '${name}': a script's config is opaque and a pointer in it would be ` +
            'written into every snapshot; read the credential from a managed env var instead',
        )
      }
    }
  }
  // The profiles validate through the core's own validators (the same
  // shape the SDK and REST take), so a typo like `path:` on a deny rule
  // fails here rather than widening the rule.
  if (raw.profiles !== undefined && raw.profiles !== null) {
    parseProfiles(raw.profiles)
  }
  if (raw.profile !== undefined && raw.profile !== null) {
    if (typeof raw.profile !== 'string') throw new Error('profile must be a string')
    const known = isPlainObject(raw.profiles) ? Object.keys(raw.profiles) : []
    if (!known.includes(raw.profile)) {
      throw new Error(`unknown profile ${JSON.stringify(raw.profile)}`)
    }
  }
  validateTypedBlock(raw.cache, CACHE_KEYS, 'cache')
  validateTypedBlock(raw.index, INDEX_KEYS, 'index')
  validateTypedBlock(raw.console, CONSOLE_KEYS, 'console')
  validateConsoleValues(raw.console)
  validateStoreBlock(raw.store)
  validateEnvBlock(raw.env)
  validateSecretsBlock(raw.secrets)
}

/**
 * The source table: one map, instance name -> declaration. Blocks
 * validate through the core schema (the same one the workspace applies
 * at build), so a pointer at a source that cannot bootstrap another
 * fails at load naming the instance. The block travels raw: an
 * instance name must not be camelized, and a source's own config keys
 * are snake_case for the same reason a mount's are.
 */
function validateSecretsBlock(value: unknown): void {
  if (value === undefined || value === null) return
  if (!isPlainObject(value)) throw new Error('config `secrets` must be a mapping')
  for (const [name, block] of Object.entries(value)) {
    if (!isPlainObject(block)) throw new Error(`config \`secrets.${name}\` must be a mapping`)
    rejectUnknownKeys(block, SOURCE_KEYS, `config \`secrets.${name}\``)
    const parsed = SecretSourceSchema.safeParse(block)
    if (!parsed.success) {
      const detail = parsed.error.issues[0]?.message ?? parsed.error.message
      throw new Error(`config \`secrets.${name}\`: ${detail}`)
    }
  }
}

/**
 * The env block: one map, name -> entry. Entries validate through the
 * core schema (the same one `varsFromEntries` applies at build), so a
 * bad entry fails at load naming the variable, and the block travels
 * raw -- variable names must not be camelized and a literal's text must
 * arrive verbatim.
 */
function validateEnvBlock(value: unknown): void {
  if (value === undefined || value === null) return
  if (!isPlainObject(value)) throw new Error('config `env` must be a mapping')
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === 'string') continue
    if (!isPlainObject(entry)) {
      throw new Error(`config \`env.${name}\` must be a string or a mapping`)
    }
    const parsed = EnvVarSchema.safeParse(entry)
    if (!parsed.success) {
      const detail = parsed.error.issues[0]?.message ?? parsed.error.message
      throw new Error(`config \`env.${name}\`: ${detail}`)
    }
  }
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
  if (isPlainObject(out.console)) out.console = camelizeKeys(out.console)
  if (isPlainObject(out.store)) {
    const store = camelizeKeys(out.store)
    for (const group of STORE_GROUPS) {
      const block = store[group]
      if (!isPlainObject(block)) continue
      if (keepsBackendSpellings(block)) continue
      store[group] = camelizeKeys(block)
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

/**
 * Validate the `profiles:` block: every entry through the core profile
 * validator, so a misspelled field is a load error rather than a
 * first-session one. A profile is the whole document it runs under, so
 * there is no chain to resolve here.
 */
function parseProfiles(raw: unknown): Record<string, SessionProfile> {
  if (!isPlainObject(raw)) throw new Error('config `profiles` must be a mapping')
  const out: Record<string, SessionProfile> = {}
  for (const [name, block] of Object.entries(raw)) {
    // A path-form script stays the string the config wrote: the check
    // door validates shape only, and runs before `absolutizeScripts`
    // has rebased the path onto the config file's directory, so reading
    // it here would resolve against the process cwd. The workspace door
    // (`toWorkspaceOptions`) loads it, the python loader's split.
    out[name] = parseSessionProfile(block, `profile \`${name}\``)
  }
  return out
}

/**
 * Load each profile's path-form script into a ScriptSource.
 *
 * By this door the path is absolute for a file config (the check door
 * rebased it onto the config file's directory); an object config's
 * relative path resolves against the process cwd, as in Python. Code
 * that passes a loaded ScriptSource is left alone.
 */
function loadProfileScripts(
  profiles: Record<string, SessionProfile>,
): Record<string, SessionProfile> {
  const out: Record<string, SessionProfile> = {}
  for (const [name, profile] of Object.entries(profiles)) {
    out[name] =
      typeof profile.script === 'string'
        ? { ...profile, script: loadScriptSource(profile.script) }
        : profile
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
    // fromEntries, not keyed assignment: this copy walks the whole
    // config, so a `__proto__` key anywhere in it (a source instance,
    // a source's own config field) would assign through the prototype
    // setter and vanish before anything downstream saw it.
    const out = Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [
        k,
        walkInterpolate(val, env, missing),
      ]),
    )
    return out
  }
  return v
}

export function interpolateEnv<T>(value: T, env: Record<string, string>): T {
  const missing: string[] = []
  const out = walkInterpolate(value, env, missing)
  if (missing.length > 0) {
    const unique = Array.from(new Set(missing)).sort(compareCodePoints)
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
  /** vfs (default), fuse, fskit, or nfs. Mirrors Python's MountBlock.backend. */
  backend?: string
  mountpoint?: string
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

interface RamConsoleBlock {
  type?: 'ram'
}

interface RedisConsoleBlock {
  type: 'redis'
  url?: string
  keyPrefix?: string
  /** Keys expire this long after the last append; null keeps them. */
  ttlSeconds?: number | null
}

interface RamStoreGroupBlock {
  type?: 'ram'
}

interface DiskStoreGroupBlock {
  type: 'disk'
  root?: string
}

interface RedisStoreGroupBlock {
  type: 'redis'
  url?: string
  keyPrefix?: string
}

/**
 * An S3 group IS an S3Config plus the discriminator, so its keys are
 * the backend's, validated by the s3 config model rather than here.
 * It hosts only the sessions+meta plane (conditional-PUT CAS), so it
 * is valid as the `workspace` override and never as the default.
 */
interface S3StoreGroupBlock extends Partial<S3Config> {
  type: 's3'
}

type StoreGroupBlock =
  | RamStoreGroupBlock
  | DiskStoreGroupBlock
  | RedisStoreGroupBlock
  | S3StoreGroupBlock

/**
 * The workspace state store: one block, four planes. The top-level
 * type/url/keyPrefix pick the default backend for every control-plane
 * group (namespace nodes, observer events, sessions + workspace
 * metadata); the optional per-group overrides redirect one group to a
 * different backend. Sessions and workspace metadata move together by
 * design, so there is one `workspace` override, not two.
 */
interface StoreBlock {
  type?: 'ram' | 'disk' | 'redis'
  url?: string
  keyPrefix?: string
  root?: string
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
  routePolicy?: string | null
  /** The profiles (`profiles:`); every entry validated by parseProfiles. */
  profiles?: unknown
  /** Which profile shapes a session created without one. */
  profile?: unknown
  mode?: string
  consistency?: string
  defaultSessionId?: string
  defaultAgentId?: string
  workspaceId?: string
  /**
   * The normalized block IS a `CacheConfig` — so it is handed to the
   * workspace as one rather than built here. A store the workspace
   * builds is a store the workspace closes; building it here would
   * leave a redis client with no owner once the workspace shut down.
   */
  cache?: CacheConfig | null
  index?: RamIndexBlock | RedisIndexBlock | null
  store?: StoreBlock | null
  /**
   * Where background-job consoles live. The redis form keys one stream
   * per job, so a reader in another process can follow a running job;
   * ram (the default) keeps consoles in memory. Mirrors Python's
   * ConsoleBlock.
   */
  console?: RamConsoleBlock | RedisConsoleBlock | null
  /**
   * The environment plane: one map, name -> entry. A bare string is
   * the literal short form; a mapping is an env entry, either a
   * literal with attrs or a managed pointer (`from`/`ref`/`key`/
   * `fetch`). Validated by `validateEnvBlock`, translated by the
   * workspace.
   */
  env?: Record<string, unknown> | null
  /**
   * The source table: one map, instance name -> declaration, spelled
   * the way `mounts:` is. A managed env entry's `from` names an
   * instance here, or a source directly when the deployment has one
   * account of it and nothing to configure.
   */
  secrets?: Record<string, unknown> | null
}

function readProcessEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

/**
 * Interpolate `${VAR}` and check every key, leaving the spelling alone.
 *
 * This is the shape that travels: the CLI prepares a config here and
 * POSTs it, and the daemon runs the same check on what arrives, so the
 * wire carries Python's snake_case exactly as `model_dump()` does on
 * that side. Camelizing before sending would make the loader have to
 * accept its own output, which is how a camelCase spelling Python
 * rejects would creep back in.
 */
export function checkWorkspaceConfig(
  source: Record<string, unknown>,
  env?: Record<string, string>,
): Record<string, unknown> {
  const raw = { ...source }
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
  validateConfigKeys(interpolated)
  return interpolated
}

export function loadWorkspaceConfig(
  source: Record<string, unknown>,
  env?: Record<string, string>,
): WorkspaceConfigRaw {
  return normalizeConfigKeys(checkWorkspaceConfig(source, env)) as unknown as WorkspaceConfigRaw
}

/**
 * Resolve relative script paths against the config file's directory.
 *
 * A path-form `script`/`route_policy` in a config file means "next to the
 * file" (the docker build-context model), never "wherever the server
 * happens to run". In-memory object configs are untouched.
 */
function absolutizeScripts(raw: Record<string, unknown>, base: string): void {
  const policy = raw.route_policy
  if (typeof policy === 'string' && isScriptPath(policy) && !isAbsolute(policy.trim())) {
    raw.route_policy = join(base, policy.trim())
  }
  if (Array.isArray(raw.runtimes)) {
    for (const entry of raw.runtimes) {
      if (isPlainObject(entry)) absolutizeScriptKey(entry, base)
    }
  }
  if (isPlainObject(raw.clis)) {
    for (const block of Object.values(raw.clis)) {
      if (!isPlainObject(block)) continue
      absolutizeScriptKey(block, base)
      absolutizeCodeRef(block, 'cli', base)
    }
  }
  if (isPlainObject(raw.mounts)) {
    for (const block of Object.values(raw.mounts)) {
      if (isPlainObject(block)) absolutizeCodeRef(block, 'resource', base)
    }
  }
  if (isPlainObject(raw.profiles)) {
    for (const block of Object.values(raw.profiles)) {
      if (isPlainObject(block)) absolutizeScriptKey(block, base)
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

/**
 * Rebase a path-form colon reference under `key` onto `base`.
 *
 * `cli: ./tool.mjs:TREE` and `resource: ./wiki.mjs:WikiResource` both
 * mean "next to the config file", the same build-context rule `script:`
 * follows; without this the pointer reaches `loadAttr` relative and
 * resolves against the server process's cwd. A package specifier
 * (`my-clis:JIRA`) is left alone: Node resolves it, not the filesystem.
 * The split is `splitRef`/`isModulePath`, the same pair `loadAttr` uses,
 * so the two cannot disagree about what a path is.
 */
function absolutizeCodeRef(entry: Record<string, unknown>, key: string, base: string): void {
  const ref = entry[key]
  if (typeof ref !== 'string' || !ref.includes(':')) return
  const [source, attr] = splitRef(ref)
  if (!isModulePath(source) || isAbsolute(source)) return
  entry[key] = `${join(base, source)}:${attr}`
}

/**
 * Read a config file into the shape that travels: checked, env
 * interpolated, script paths resolved against the file's directory —
 * and still spelled the way the file spelled it. What a CLI sends to
 * the daemon.
 */
export function checkWorkspaceConfigFile(
  path: string,
  env?: Record<string, string>,
): Record<string, unknown> {
  const text = readFileSync(path, 'utf-8')
  const parsed: unknown = parseYaml(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`config source must be a mapping`)
  }
  const config = checkWorkspaceConfig(parsed as Record<string, unknown>, env)
  absolutizeScripts(config, dirname(resolve(path)))
  return config
}

export function loadWorkspaceConfigFile(
  path: string,
  env?: Record<string, string>,
): WorkspaceConfigRaw {
  return normalizeConfigKeys(checkWorkspaceConfigFile(path, env)) as unknown as WorkspaceConfigRaw
}

export interface WorkspaceArgs {
  resources: Record<string, [Resource, MountMode, Record<string, Limit>]>
  /**
   * Exactly what `new Workspace` takes, minus the two the loader always
   * resolves. Spelling the fields out here instead is what once dropped
   * `clis` and the deny rules on the way to the daemon: a config knob was
   * parsed and validated, then discarded by a list nobody remembered to
   * extend.
   */
  options: WorkspaceOptions & { mode: MountMode; consistency: ConsistencyPolicy }
  kernelMounts: Record<string, [MountBackend, string | undefined]>
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
  if (block.type === 'disk') {
    return new DiskWorkspaceStateStore({
      ...(block.root !== undefined ? { root: block.root } : {}),
    })
  }
  if (block.type === 's3') {
    // The block IS the S3Config once the discriminator is dropped, so
    // new S3Config fields flow through without being re-declared here
    // (the same reason Python's S3StoreBlock subclasses S3Config). The
    // keys are still the file's snake_case ones, so they go through the
    // same translation the s3 mount uses — `key_prefix` and friends do
    // not survive a plain camelize.
    const s3: Record<string, unknown> = { key_prefix: 'mirage/', ...block }
    delete s3.type
    return new S3WorkspaceStateStore(normalizeS3Config(s3))
  }
  return new RAMWorkspaceStateStore()
}

// Build one job's console on its own Redis stream. The key carries a
// fresh nonce beside the job id, because job ids restart at 1 when the
// table empties and a reused stream would replay the previous job's
// chunks. The minted prefix is published as the store's keyPrefix
// (reachable as job.console.store), so an embedder can hand a reader
// in another process the console's address. Keys expire ttl_seconds
// after the last append (default one day) so finished jobs cannot
// accumulate in Redis forever. The workspace closes what this builds
// at teardown (JobTable.closeConsoles). Mirrors Python's
// _redis_console.
function buildConsoleFactory(
  block: RamConsoleBlock | RedisConsoleBlock | null | undefined,
): ConsoleFactory | undefined {
  if (block?.type !== 'redis') return undefined
  const url = block.url ?? 'redis://localhost:6379/0'
  const keyPrefix = block.keyPrefix ?? 'mirage:console:'
  const ttlSeconds = block.ttlSeconds === undefined ? 86400 : block.ttlSeconds
  return (jobId: number) =>
    new JobConsole(
      new RedisConsoleStore({
        url,
        keyPrefix: `${keyPrefix}${randomBytes(6).toString('hex')}:${jobId.toString()}:`,
        ...(ttlSeconds !== null ? { ttlSeconds } : {}),
      }),
    )
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
  if (block.type === 'disk') {
    return new DiskWorkspaceStateStore({
      ...(block.root !== undefined ? { root: block.root } : {}),
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
  // Built before the mounts, because a mount's config may point at one:
  // `resolveConfigSecrets` inside `buildResource` fetches through these.
  const blocks = [...Object.values(cfg.mounts), ...Object.values(cfg.clis ?? {})]
  const sources = await resolveSourcesFor(
    cfg.secrets,
    blocks.map((block) => block.config ?? {}),
  )
  for (const [prefix, block] of Object.entries(cfg.mounts)) {
    const r = await buildResource(block.resource, block.config ?? {}, sources)
    const m = coerceMountMode(block.mode, wsMode)
    resources[prefix] = [r, m, parseLimits(block.command_limits)]
    const backend = (block.backend ?? MountBackend.VFS) as MountBackend
    if (KERNEL_BACKENDS.includes(backend)) kernelMounts[prefix] = [backend, block.mountpoint]
  }
  const index = buildIndex(cfg.index)
  const stateStore = buildStateStore(cfg.store)
  const cliEntries =
    cfg.clis !== undefined && cfg.clis !== null
      ? await buildCliEntries(cfg.clis, sources)
      : undefined
  const consoleFactory = buildConsoleFactory(cfg.console)
  return {
    resources,
    options: {
      mode: wsMode,
      consistency,
      ...(cfg.defaultSessionId !== undefined ? { sessionId: cfg.defaultSessionId } : {}),
      ...(cfg.defaultAgentId !== undefined ? { agentId: cfg.defaultAgentId } : {}),
      ...(cfg.workspaceId !== undefined ? { workspaceId: cfg.workspaceId } : {}),
      ...(cfg.cache !== undefined && cfg.cache !== null ? { cache: cfg.cache } : {}),
      ...(index !== undefined ? { index } : {}),
      // Built here for this workspace alone, so it is the workspace's
      // to close — a redis or s3 store has a client that nothing else
      // would ever release. Mirrors the `owns_store` Python's loader
      // sets beside the same store.
      ...(stateStore !== undefined ? { store: stateStore, ownsStore: true } : {}),
      ...(consoleFactory !== undefined ? { consoleFactory } : {}),
      ...(cfg.runtimes !== undefined && cfg.runtimes !== null
        ? { runtimes: buildRuntimeEntries(cfg.runtimes) }
        : {}),
      ...(cfg.routePolicy !== undefined && cfg.routePolicy !== null
        ? { routePolicy: loadScriptSource(cfg.routePolicy) }
        : {}),
      ...(cfg.profiles !== undefined && cfg.profiles !== null
        ? { profiles: loadProfileScripts(parseProfiles(cfg.profiles)) }
        : {}),
      ...(cfg.profile !== undefined && cfg.profile !== null
        ? { profile: cfg.profile as string }
        : {}),
      ...(cliEntries !== undefined ? { clis: cliEntries } : {}),
      // Passed through as-is: this door resolves resources, and
      // env-plane fetching is async at command time, so no fetching
      // here (the workspace translates and validates sources).
      ...(cfg.env !== undefined && cfg.env !== null ? { env: cfg.env as EnvEntries } : {}),
      // Same reason: building a source reads its bootstrap pointers,
      // which the workspace does once, before its first fetch.
      ...(cfg.secrets !== undefined && cfg.secrets !== null
        ? { secrets: cfg.secrets as SecretEntries }
        : {}),
    },
    kernelMounts,
  }
}

/** Resolve a `cli:` value: a bare name stays a name, a ref loads a spec. */
async function resolveCliRef(ref: string, name: string): Promise<string | CLISpec> {
  if (!ref.includes(':')) return ref
  return asCliSpec(await loadAttr(ref), name, ref)
}

/**
 * True when a value carries every field the CLI walker reads, at every
 * level of the tree.
 *
 * This is the invariant `CLISpec`'s own constructor enforces, checked
 * again here because the constructor that ran was not necessarily ours.
 * The fields are the ones dispatch and `man` actually touch
 * (`subcommands.find`, `aliases.includes`, `options.some`), so a value
 * that passes cannot fail later reading a missing one. A class name is
 * not enough on its own: any class called `CLISpec`, or an object with a
 * `constructor` property that says so, would answer to that and then
 * crash on the first line an agent types.
 */
function looksLikeCliSpec(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const node = value as Record<string, unknown>
  if (typeof node.name !== 'string' || node.name === '' || /\s/.test(node.name)) return false
  if (!Array.isArray(node.aliases) || !Array.isArray(node.options)) return false
  if (!Array.isArray(node.subcommands)) return false
  const runnable =
    typeof node.fn === 'function' ||
    (node.script !== null && node.script !== undefined) ||
    node.subcommands.length > 0
  if (!runnable) return false
  return node.subcommands.every(looksLikeCliSpec)
}

/**
 * Check that a `cli:` reference resolved to a program tree.
 *
 * `instanceof` is the fast path, not the test. The referenced file lives
 * in someone else's project, which is the whole point of the ref form,
 * and that project may resolve its own copy of `@struktoai/mirage-core`:
 * a real CLISpec carrying every method, built off a different class
 * object. Demanding `instanceof` would refuse exactly the case this
 * exists to serve, so anything else is admitted on its shape instead,
 * and refused at create time rather than when an agent first types the
 * head word.
 */
function asCliSpec(value: unknown, name: string, ref: string): CLISpec {
  if (value instanceof CLISpec) return value
  if (looksLikeCliSpec(value)) return value as CLISpec
  throw new Error(`clis entry '${name}': ${ref} is not a CLISpec`)
}

async function buildCliEntries(
  clis: Record<string, CLIBlock>,
  sources?: Readonly<Record<string, ResolvedSource>>,
): Promise<Record<string, [string | CLISpec, Record<string, unknown> | null]>> {
  const out: Record<string, [string | CLISpec, Record<string, unknown> | null]> = {}
  for (const [name, block] of Object.entries(clis as Record<string, unknown>)) {
    // The raw config arrives as unvalidated YAML: the CLIBlock type is
    // a claim, not a guarantee, so validate the shape here.
    if (!isPlainObject(block)) {
      throw new Error(`clis entry '${name}' must be a mapping`)
    }
    const unknown = Object.keys(block).filter((k) => !CLI_KEYS.includes(k))
    if (unknown.length > 0) {
      throw new Error(
        `clis entry '${name}': unknown keys: ${unknown.sort(compareCodePoints).join(', ')}`,
      )
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
    // A `cli` value carrying a colon points at code: `./tool.mjs:TALLY`
    // (a file) or `my-clis:JIRA` (a package specifier). A bare name stays
    // a name for the workspace to resolve against the registered specs.
    // Mirrors the `":" in name` branch of Python's `cli_spec_for`, one
    // layer up: `cliSpecFor` lives in core, which has no filesystem and
    // is synchronous. A `resource:` value reads the same way, resolved by
    // `buildResource` rather than here, because a mount block reaches the
    // registry and a `clis` block does not.
    const entry = hasScript
      ? new CLISpec({
          name,
          script: loadScriptSource(block.script as string),
          runtime: block.runtime ?? null,
        })
      : await resolveCliRef(block.cli as string, name)
    // A CLI credential reads a pointer the way a mount's does: the
    // account CLI's `config_model` is the same model a resource
    // parses, so it must receive the credential, not the pointer.
    out[name] = [
      entry,
      await resolveConfigSecrets(block.config ?? {}, sources, `clis.${name}.config`),
    ]
  }
  return out
}
