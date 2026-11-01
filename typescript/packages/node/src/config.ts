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

import type { CacheConfig } from '@struktoai/mirage-core/cache/file/config'
import type { IndexConfig, RedisIndexConfig } from '@struktoai/mirage-core/cache/index/config'
import { CLI } from '@struktoai/mirage-core/commands/cli/types'
import { CommandSpec } from '@struktoai/mirage-core/commands/spec/types'
import { IOConfig } from '@struktoai/mirage-core/io/config'
import {
  networkLayer,
  networkRoutes,
  NetworkRule,
  type NetworkSetting,
} from '@struktoai/mirage-core/io/network'
import { parseCommandLimits } from '@struktoai/mirage-core/policy/builtin/output_cap'
import { METHODS } from '@struktoai/mirage-core/policy/constants'
import {
  compileProgram,
  parseProgram,
  SessionProfile,
  type ProfilePolicySpec,
} from '@struktoai/mirage-core/policy/profile'
import type {
  PolicyMethod,
  ProfileScript,
  ProfileScripts,
} from '@struktoai/mirage-core/policy/types'
import { validateDocument } from '@struktoai/mirage-core/rs/document'
import { Runtime, type RuntimeEntry } from '@struktoai/mirage-core/runtime/base'
import type { RuntimeOptions } from '@struktoai/mirage-core/runtime/config'
import { buildRuntime, checkRuntimeOptions } from '@struktoai/mirage-core/runtime/table'
import { ScriptSource } from '@struktoai/mirage-core/runtime/types'
import {
  EnvVar,
  SecretSource,
  type EnvEntries,
  type SecretEntries,
} from '@struktoai/mirage-core/secrets/config'
import {
  configHoldsPointer,
  resolveConfigSecrets,
  resolveSourcesFor,
} from '@struktoai/mirage-core/secrets/sources'
import type { ResolvedSource } from '@struktoai/mirage-core/secrets/types'
import {
  KERNEL_BACKENDS,
  MountBackend,
  MountMode,
  parseMountMode,
  ReadPolicy,
  type ReadSpec,
} from '@struktoai/mirage-core/types'
import { parseSystemTime } from '@struktoai/mirage-core/utils/clock'
import { snakeToCamel } from '@struktoai/mirage-core/utils/normalize'
import { isPlainObject } from '@struktoai/mirage-core/utils/records'
import { parseLimit } from '@struktoai/mirage-core/utils/size'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import { parseConfigWithSchema } from '@struktoai/mirage-core/vfs/secrets'
import {
  coerceReadPolicy,
  resolveReadSpec,
} from '@struktoai/mirage-core/workspace/mount/read_policy'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { coerceWritePolicy } from '@struktoai/mirage-core/workspace/mount/write_policy'
import type { WorkspaceStateStore } from '@struktoai/mirage-core/workspace/store/base'
import { RAMWorkspaceStateStore } from '@struktoai/mirage-core/workspace/store/ram'
import { S3WorkspaceStateStore } from '@struktoai/mirage-core/workspace/store/s3'
import type { WorkspaceOptions } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
// The config loader is a workspace entry point of its own (the daemon
// builds from here), so it arms the builtin secrets sources like the
// node Workspace module does.
import './secrets/constants.ts'
import { isModulePath, loadAttr, splitRef } from './utils/loader.ts'
import { parseYaml } from './utils/yaml.ts'
import { buildVfs } from './vfs/registry.ts'
import { S3Config } from './vfs/s3/config.ts'
import { DiskWorkspaceStateStore } from './workspace/store/disk.ts'
import { RedisWorkspaceStateStore } from './workspace/store/redis.ts'

function coerceMountMode(value: string | undefined, fallback: MountMode): MountMode {
  if (value === undefined) return fallback
  return parseMountMode(value.toLowerCase())
}

/** True for the docker-style single-line script path form (.py/.js/.mjs). */
function isScriptPath(value: string): boolean {
  return !value.includes('\n') && ['.py', '.js', '.mjs'].some((ext) => value.trim().endsWith(ext))
}

// Config carries a reference, the wire carries content (the docker
// build-context model): the value must be a path to a .py/.js/.mjs file,
// read at load time. In code, a program is passed as a ScriptSource. The
// extension stamps the script's language.
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

type RuntimeClass = new (options?: RuntimeOptions<never>) => Runtime

/**
 * Load the `Runtime` subclass a `source:Class` reference names.
 *
 * The runtime twin of the `vfs:` and `cli:` reference forms: a
 * deployment ships a runtime as a file and names it from yaml with no
 * host program calling `registerRuntime`. The class is constructed with
 * the uniform `(captures, config)` options like a builtin, so the entry's
 * other keys reach it unchanged. Mirrors `_runtime_class` in
 * `mirage/config.py`.
 */
async function loadRuntimeClass(ref: string): Promise<RuntimeClass> {
  const loaded = await loadAttr(ref)
  if (typeof loaded !== 'function' || !(loaded.prototype instanceof Runtime)) {
    throw new Error(`${JSON.stringify(ref)} is not a Runtime subclass`)
  }
  return loaded as RuntimeClass
}

/**
 * Turn config runtime entries into workspace runtime entries: names, or
 * mappings carrying a name plus the uniform runtime options. A name is a
 * registered runtime or a `source:Class` reference to a `Runtime`
 * subclass.
 */
async function buildRuntimeEntries(entries: unknown[]): Promise<RuntimeEntry[]> {
  const out: RuntimeEntry[] = []
  for (const entry of entries) {
    if (typeof entry === 'string') {
      out.push(entry.includes(':') ? new (await loadRuntimeClass(entry))() : buildRuntime(entry))
      continue
    }
    if (!isPlainObject(entry)) throw new Error('runtime entry must be a name or a mapping')
    const { name, ...options } = entry
    if (typeof name !== 'string' || name === '') {
      throw new Error("runtime entry needs a non-empty 'name'")
    }
    if (name.includes(':')) {
      // The key check `buildRuntime` runs for a name: the base
      // constructor ignores a key it does not read, so without it a typo
      // would leave the runtime on its defaults where Python's
      // `**options` refuses the entry.
      const cls = await loadRuntimeClass(name)
      checkRuntimeOptions(name, options)
      out.push(new cls(options as RuntimeOptions<never>))
      continue
    }
    out.push(buildRuntime(name, options))
  }
  return out
}

function camelizeKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) out[snakeToCamel(k)] = v
  return out
}

const STORE_GROUPS = ['namespace', 'observer', 'workspace', 'jobs'] as const

const CLI_KEYS: readonly string[] = ['cli', 'script', 'runtime', 'config']

// Python's index block models refuse a ttl that is not a number
// (StrictFloat) and a non-string url or key_prefix at load. This stops at
// the first bad value, so it checks them in the models' field order.
function validateIndexValues(value: unknown, what: string): void {
  if (!isPlainObject(value)) return
  if (value.ttl !== undefined && typeof value.ttl !== 'number') {
    throw new Error(`config \`${what}.ttl\` must be a number`)
  }
  if (value.url !== undefined && typeof value.url !== 'string') {
    throw new Error(`config \`${what}.url\` must be a string`)
  }
  if (value.key_prefix !== undefined && typeof value.key_prefix !== 'string') {
    throw new Error(`config \`${what}.key_prefix\` must be a string`)
  }
}

/** A raw block's `config`, or an empty mapping when it is absent or not one. */
function asConfig(value: unknown): Readonly<Record<string, unknown>> {
  return isPlainObject(value) ? value : {}
}

/**
 * Refuse a mount block whose read policy and bound disagree.
 *
 * Both rules live at the config loader rather than in the mount-time
 * verdict: once a ReadSpec exists its ttl has already defaulted, so
 * `bounded` written without a bound is indistinguishable from `read:`
 * left out entirely. Python refuses the same pair in `MountBlock`'s
 * model validator, which is the same entry point.
 */
function validateReadBlock(prefix: string, block: Record<string, unknown>): void {
  // Coerce once, then apply both dependent-key rules to the normalised
  // value. Comparing the raw one let `read: BOUNDED` -- a spelling both
  // languages accept -- skip the bound rule that Python enforces.
  const declared = block.read ?? undefined
  const policy = declared === undefined ? undefined : coerceReadPolicy(declared)
  const ttl = block.ttl ?? undefined
  // The bound's type is judged whatever `read:` says, and before the
  // dependent-key rules, because that is where Python judges it: a
  // field validator, which runs ahead of the model validator carrying
  // those rules. Left until after them, `ttl: "30"` with no `read:`
  // came back naming the missing policy on one host and the unusable
  // bound on the other.
  if (ttl !== undefined && (typeof ttl !== 'number' || !Number.isInteger(ttl))) {
    throw new Error(`mount \`${prefix}\`: ttl must be whole seconds, got ${JSON.stringify(ttl)}`)
  }
  if (ttl !== undefined && policy === undefined) {
    throw new Error(`mount \`${prefix}\`: ttl pins the read bound; it takes read: bounded`)
  }
  if (policy === ReadPolicy.BOUNDED && ttl === undefined) {
    throw new Error(`mount \`${prefix}\`: read: bounded needs a bound; set ttl:`)
  }
  if (ttl !== undefined && ttl < 1) {
    throw new Error(`mount \`${prefix}\`: ttl must be at least 1 second, got ${String(ttl)}`)
  }
}

/**
 * Reject any key no Python config model declares, before normalization
 * folds snake_case into camelCase and the distinction is gone.
 */
function validateConfigKeys(raw: Record<string, unknown>): void {
  validateDocument('config', raw, 'config')
  parseCommandLimits(raw.command_limits)
  if (raw.max_memory !== undefined && raw.max_memory !== null) {
    parseLimit(raw.max_memory as string | number, 'max_memory')
  }
  if (raw.network !== undefined) {
    const layer = networkLayer(raw.network)
    new NetworkRule(
      layer === null ? [] : [layer],
      false,
      networkRoutes(raw.network as NetworkSetting),
    )
  }
  if (raw.system_time !== undefined && raw.system_time !== null) {
    if (typeof raw.system_time !== 'string') throw new Error('system_time must be a string')
    parseSystemTime(raw.system_time)
  }
  // At the sync entry point, as Python's WorkspaceConfig validator is, so the CLI
  // refuses a bad value before it POSTs the document to the daemon.
  if (raw.read !== undefined && raw.read !== null) resolveReadSpec(raw.read, undefined)
  if (raw.write !== undefined && raw.write !== null) coerceWritePolicy(raw.write)
  if (isPlainObject(raw.mounts)) {
    for (const [prefix, block] of Object.entries(raw.mounts)) {
      if (!isPlainObject(block)) throw new Error(`mount \`${prefix}\` must be a mapping`)
      validateDocument('config', block, `mount \`${prefix}\``, { names: 'mount' })
      // Before the read rules, as pydantic checks fields before them.
      validateDocument('config', block.index, `mounts.${prefix}.index`, { names: 'index' })
      validateIndexValues(block.index, `mounts.${prefix}.index`)
      validateReadBlock(prefix, block)
      if (block.write !== undefined && block.write !== null) coerceWritePolicy(block.write)
      parseCommandLimits(block.command_limits)
    }
  }
  if (isPlainObject(raw.clis)) {
    for (const [name, block] of Object.entries(raw.clis)) {
      if (!isPlainObject(block)) throw new Error(`cli \`${name}\` must be a mapping`)
      validateDocument('config', block, `cli \`${name}\``, { names: 'cli' })
      // A pointer may only fill a config that a model validates, because
      // the model is what a snapshot redacts by. A script's config is
      // opaque: nothing declares which key is a credential, so the
      // snapshot captures it verbatim, and a pointer resolved into it
      // would be written out as the value it fetched. Refused here, on
      // the block, so every entry point that reads a config inherits the rule.
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
  if (raw.route_policy !== undefined && raw.route_policy !== null) {
    parseProgram(raw.route_policy, 'route_policy')
  }
  if (raw.profile !== undefined && raw.profile !== null) {
    if (typeof raw.profile !== 'string') throw new Error('profile must be a string')
    const known = isPlainObject(raw.profiles) ? Object.keys(raw.profiles) : []
    if (!known.includes(raw.profile)) {
      throw new Error(`unknown profile ${JSON.stringify(raw.profile)}`)
    }
  }
  if (raw.io !== undefined) {
    if (!isPlainObject(raw.io)) throw new Error('io must be a mapping')
    validateDocument('config', raw.io, 'io', { names: 'io' })
    new IOConfig(camelizeKeys(raw.io))
  }
  validateDocument('config', raw.cache, 'cache', { names: 'cache' })
  if (isPlainObject(raw.cache) && raw.cache.limit !== undefined) {
    parseLimit(raw.cache.limit as string | number, 'limit')
  }
  validateDocument('config', raw.index, 'index', { names: 'index' })
  validateIndexValues(raw.index, 'index')
  validateDocument('config', raw.store, 'store', { names: 'store' })
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
    validateDocument('config', block, `config \`secrets.${name}\``, { names: 'source' })
    const parsed = SecretSource.safeParse(block)
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
    const parsed = EnvVar.safeParse(entry)
    if (!parsed.success) {
      const detail = parsed.error.issues[0]?.message ?? parsed.error.message
      throw new Error(`config \`env.${name}\`: ${detail}`)
    }
  }
}

// Workspace YAML uses Python's snake_case keys (default_session_id, the
// cache/index key_prefix/max_drain_bytes, ...). TS code stays camelCase, so
// normalize at the boundary: camelize the top-level keys plus the cache and
// index blocks. A mount block is left in its own spelling but for its
// `index:`: its `config:` carries VFS credentials whose snake_case keys
// (aws_access_key_id, ...) are consumed downstream as-is, and
// command_limits is parsed separately. The mounts map is rebuilt, as
// the store block is, rather than edited.
function normalizeConfigKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const out = camelizeKeys(raw)
  if (isPlainObject(out.io)) out.io = camelizeKeys(out.io)
  if (isPlainObject(out.cache)) out.cache = camelizeKeys(out.cache)
  if (isPlainObject(out.index)) out.index = camelizeKeys(out.index)
  if (isPlainObject(out.mounts)) {
    out.mounts = Object.fromEntries(
      Object.entries(out.mounts).map(([prefix, block]) => [
        prefix,
        isPlainObject(block) && isPlainObject(block.index)
          ? { ...block, index: camelizeKeys(block.index) }
          : block,
      ]),
    )
  }
  if (isPlainObject(out.store)) {
    const store = camelizeKeys(out.store)
    for (const group of STORE_GROUPS) {
      const block = store[group]
      if (!isPlainObject(block)) continue
      // An s3 group carries its backend's own spellings (`aws_access_key_id`
      // is `accessKeyId`), which a plain camelize would hide from the
      // translation that knows them.
      if (block.type === 's3') continue
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
    // entry point validates shape only, and runs before `absolutizeScripts`
    // has rebased the path onto the config file's directory, so reading
    // it here would resolve against the process cwd. The workspace entry point
    // (`toWorkspaceOptions`) loads it, the python loader's split.
    out[name] = SessionProfile(block, `profile \`${name}\``)
  }
  return out
}

/** A path-form policy program with its script loaded; one carrying source is left alone. */
function loadProgram(program: ProfilePolicySpec): ProfilePolicySpec {
  return typeof program.script === 'string'
    ? { ...program, script: loadScriptSource(program.script) }
    : program
}

/**
 * Load a profile's path-form policy programs into ScriptSources.
 *
 * By this entry point the path is absolute for a file config (the check entry point
 * rebased it onto the config file's directory); an object config's
 * relative path resolves against the process cwd, as in Python. Code
 * that passes a loaded ScriptSource is left alone.
 */
export function loadProfilePolicy(profile: SessionProfile): SessionProfile {
  const policy = profile.policy
  return policy == null
    ? profile
    : {
        ...profile,
        policy: Object.fromEntries(
          Object.entries(policy).map(([method, programs]) => [method, programs.map(loadProgram)]),
        ),
      }
}

/**
 * Load a server's policy file: a profile's `policy` block, a mapping of
 * method to programs, plus `pre_workspace`, which a server asks before it
 * builds a workspace. A relative `script` path is read next to the file,
 * after `${VAR}` interpolation. Mirrors Python's `load_policy_file`.
 */
export function loadPolicyFile(path: string, env?: Record<string, string>): ProfileScripts {
  const raw = interpolateEnv(parseYaml(readFileSync(path, 'utf8')), env ?? readProcessEnv())
  const methods: readonly string[] = [...Object.values(METHODS), 'pre_workspace']
  if (!isPlainObject(raw)) {
    throw new Error(`${path}: a policy file is a mapping of method to programs`)
  }
  const unknown = Object.keys(raw).filter((key) => !methods.includes(key))
  if (unknown.length > 0) {
    throw new Error(
      `${path}: names ${unknown.sort(compareCodePoints).join(', ')}; a program answers at ` +
        methods.join(', '),
    )
  }
  const base = dirname(resolve(path))
  const scripts: Partial<Record<PolicyMethod, readonly ProfileScript[]>> = {}
  for (const [method, programs] of Object.entries(raw)) {
    if (!Array.isArray(programs)) throw new Error(`${path}: ${method} is a list of programs`)
    scripts[snakeToCamel(method) as PolicyMethod] = programs.map((program: unknown, i) => {
      if (isPlainObject(program)) absolutizeScriptKey(program, base)
      const parsed = parseProgram(program, `${path}: ${method}[${String(i)}]`)
      return compileProgram(loadProgram(parsed), basename(path))
    })
  }
  return scripts
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

export interface MountBlock {
  vfs: string
  mode?: string
  config?: Record<string, unknown>
  command_limits?: Record<string, Record<string, unknown>>
  /** workspace (default), fuse, or fskit. Mirrors Python's MountBlock.backend. */
  backend?: string
  mountpoint?: string
  /**
   * How cached bytes for this mount are revalidated, and the bound that
   * goes with `bounded`. The bound lives only in a mount block: at
   * workspace level it would sit beside `index: {ttl:}`.
   */
  read?: string
  ttl?: number
  /** Overrides the workspace `write:` as `mode` does. */
  write?: string | null
  /** Replaces the workspace `index:` whole; nothing is inherited. */
  index?: RedisIndexBlock | (RamIndexBlock & { type: 'ram' }) | null
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

interface RamStoreBlock {
  type?: 'ram'
}

interface DiskStoreBlock {
  type: 'disk'
  root?: string
}

interface RedisStoreBlock {
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
interface S3StoreBlock extends Partial<S3Config> {
  type: 's3'
}

type StoreGroupBlock = RamStoreBlock | DiskStoreBlock | RedisStoreBlock | S3StoreBlock

/**
 * The workspace state store: one block, five planes. The top-level
 * type/url/keyPrefix pick the default backend for every control-plane
 * group (namespace nodes, observer events, sessions + workspace
 * metadata, jobs); the optional per-group overrides redirect one group
 * to a different backend. Sessions and workspace metadata move together
 * by design, so there is one `workspace` override, not two. A disk store
 * keeps jobs in memory, since a job's console is a stream other processes
 * follow, so the `jobs` group is ram or redis.
 */
interface StoreBlock {
  type?: 'ram' | 'disk' | 'redis'
  url?: string
  keyPrefix?: string
  root?: string
  namespace?: StoreGroupBlock | null
  observer?: StoreGroupBlock | null
  workspace?: StoreGroupBlock | null
  jobs?: StoreGroupBlock | null
}

/**
 * One `clis:` entry: install a named CLI with its own config. The
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
  io?: Partial<IOConfig>
  commandLimits?: unknown
  /** What the RAM mounts store and a command builds may hold; null for no cap. */
  maxMemory?: string | number | null
  /** Where the workspace's connections may go; validated by networkLayer. */
  network?: NetworkSetting
  /** The workspace's time when it starts; validated by parseSystemTime. */
  systemTime?: string | null
  mounts: Record<string, MountBlock>
  clis?: Record<string, CLIBlock> | null
  runtimes?: (string | Record<string, unknown>)[] | null
  /** The route policy program, `{script, runtime}`; validated by parseProgram. */
  routePolicy?: unknown
  /** The profiles (`profiles:`); every entry validated by parseProfiles. */
  profiles?: unknown
  /** Which profile shapes a session created without one. */
  profile?: unknown
  mode?: string
  read?: string
  /** The write policy a mount inherits when it declares none. */
  write?: string | null
  defaultSessionId?: string
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

/** The process environment with its unset entries dropped. */
export function readProcessEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

/**
 * Interpolate `${VAR}` and check every key, leaving the spelling alone.
 * `env` is where a name is read, the process's by default; null reads
 * none and leaves every `${VAR}` as written.
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
  env?: Record<string, string> | null,
): Record<string, unknown> {
  const raw = { ...source }
  const interpolated = env === null ? raw : interpolateEnv(raw, env ?? readProcessEnv())
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
  env?: Record<string, string> | null,
): WorkspaceConfigRaw {
  return normalizeConfigKeys(checkWorkspaceConfig(source, env)) as unknown as WorkspaceConfigRaw
}

/**
 * Resolve relative script paths and code refs against the config file's
 * directory.
 *
 * A path-form `script`, a `cli: ./tool.mjs:TREE`, a
 * `vfs: ./wiki.mjs:WikiVFS` and a runtime entry's
 * `name: ./box.mjs:EchoBox` in a config file all mean "next to the file"
 * (the docker build-context model), never "wherever the server happens
 * to run". In-memory object configs are untouched. Exported so
 * the CLI applies the same rebase to a `load`/`clone` override, which is
 * read without validation and so cannot go through
 * `checkWorkspaceConfigFile`; mirrors `_absolutize_scripts` in
 * `mirage/config.py`.
 */
export function absolutizeScripts(raw: Record<string, unknown>, base: string): void {
  if (isPlainObject(raw.route_policy)) absolutizeScriptKey(raw.route_policy, base)
  if (Array.isArray(raw.runtimes)) {
    raw.runtimes.forEach((entry: unknown, i: number) => {
      if (isPlainObject(entry)) {
        absolutizeCodeRef(entry, 'name', base)
      } else if (typeof entry === 'string') {
        ;(raw.runtimes as unknown[])[i] = rebaseCodeRef(entry, base)
      }
    })
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
      if (isPlainObject(block)) absolutizeCodeRef(block, 'vfs', base)
    }
  }
  if (isPlainObject(raw.profiles)) {
    for (const block of Object.values(raw.profiles)) {
      // A profile's policy programs carry their scripts the way a clis
      // entry does, so each `script` rebases the same way.
      if (!isPlainObject(block) || !isPlainObject(block.policy)) continue
      for (const programs of Object.values(block.policy)) {
        if (!Array.isArray(programs)) continue
        for (const program of programs) {
          if (isPlainObject(program)) absolutizeScriptKey(program, base)
        }
      }
    }
  }
}

/** Rebase one clis entry's, policy program's or route_policy's relative `script` path onto `base`. */
function absolutizeScriptKey(entry: Record<string, unknown>, base: string): void {
  const script = entry.script
  if (typeof script === 'string' && isScriptPath(script) && !isAbsolute(script.trim())) {
    entry.script = join(base, script.trim())
  }
}

/**
 * Rebase a path-form colon reference under `key` onto `base`.
 *
 * `cli: ./tool.mjs:TREE`, `vfs: ./wiki.mjs:WikiVFS` and a
 * runtime entry's `name: ./box.mjs:EchoBox` all mean "next to the config
 * file", the same build-context rule `script:` follows; without this the
 * pointer reaches `loadAttr` relative and
 * resolves against the server process's cwd. A package specifier
 * (`my-clis:JIRA`) is left alone: Node resolves it, not the filesystem.
 * The split is `splitRef`/`isModulePath`, the same pair `loadAttr` uses,
 * so the two cannot disagree about what a path is.
 */
function absolutizeCodeRef(entry: Record<string, unknown>, key: string, base: string): void {
  const ref = entry[key]
  if (typeof ref === 'string') entry[key] = rebaseCodeRef(ref, base)
}

/**
 * `ref` with a relative path-form source rebased onto `base`. Anything
 * that is not a relative path-form reference (a bare name, a package
 * specifier, an absolute path) comes back unchanged, so the bare string
 * runtime entry (`- ./box.mjs:EchoBox` beside `- monty`) reads the same
 * way the keyed forms do.
 */
function rebaseCodeRef(ref: string, base: string): string {
  if (!ref.includes(':')) return ref
  const [source, attr] = splitRef(ref)
  if (!isModulePath(source) || isAbsolute(source)) return ref
  return `${join(base, source)}:${attr}`
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
  const parsed = parseYaml(text)
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

function buildIndexConfig(
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
    return new S3WorkspaceStateStore(parseConfigWithSchema(S3Config, s3))
  }
  return new RAMWorkspaceStateStore()
}

function buildStateStore(block: StoreBlock | null | undefined): WorkspaceStateStore | undefined {
  if (block === null || block === undefined) return undefined
  const overrides = {
    ...(block.namespace != null ? { namespace: buildStoreGroup(block.namespace) } : {}),
    ...(block.observer != null ? { observer: buildStoreGroup(block.observer) } : {}),
    ...(block.workspace != null ? { workspace: buildStoreGroup(block.workspace) } : {}),
    ...(block.jobs != null ? { jobs: buildStoreGroup(block.jobs) } : {}),
  }
  if (block.type === 'redis') {
    return new RedisWorkspaceStateStore({
      ...(block.url !== undefined ? { url: block.url } : {}),
      ...(block.keyPrefix !== undefined ? { keyPrefix: block.keyPrefix } : {}),
      ...(block.root !== undefined ? { root: block.root } : {}),
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

/**
 * The mounts and the options `new Workspace` takes, minus the two the loader
 * always resolves. The options are `WorkspaceOptions` itself: spelling the
 * fields out instead is what once dropped `clis` and the deny rules on the
 * way to the daemon, a config knob parsed and validated, then discarded by
 * a list nobody remembered to extend.
 */
export async function configToWorkspaceArgs(cfg: WorkspaceConfigRaw): Promise<{
  mounts: Record<string, Mount>
  options: WorkspaceOptions & { mode: MountMode; read: ReadSpec }
  kernelMounts: Record<string, [MountBackend, string | undefined]>
}> {
  const wsMode = coerceMountMode(cfg.mode, MountMode.WRITE)
  const defaultRead = resolveReadSpec(cfg.read, undefined)
  const defaultWrite = coerceWritePolicy(cfg.write)
  const mounts: Record<string, Mount> = {}
  const kernelMounts: Record<string, [MountBackend, string | undefined]> = {}
  // Built before the mounts, because a mount's config may point at one:
  // `resolveConfigSecrets` inside `buildVfs` fetches through these.
  const blocks = [...Object.values(cfg.mounts), ...Object.values(cfg.clis ?? {})]
  const sources = await resolveSourcesFor(
    cfg.secrets,
    blocks.map((block) => block.config ?? {}),
  )
  for (const [prefix, block] of Object.entries(cfg.mounts)) {
    const r = await buildVfs(block.vfs, block.config ?? {}, sources)
    const m = coerceMountMode(block.mode, wsMode)
    // Already validated by the sync entry point (validateReadBlock).
    const read = block.read === undefined ? defaultRead : resolveReadSpec(block.read, block.ttl)
    const mountIndex = buildIndexConfig(block.index)
    const write =
      block.write === undefined || block.write === null
        ? defaultWrite
        : coerceWritePolicy(block.write)
    mounts[prefix] = new Mount(r, {
      mode: m,
      read,
      write,
      commandLimits: parseCommandLimits(block.command_limits),
      vfsRef: block.vfs,
      ...(mountIndex !== undefined ? { index: mountIndex } : {}),
    })
    const backend = (block.backend ?? MountBackend.WORKSPACE) as MountBackend
    if (KERNEL_BACKENDS.includes(backend)) kernelMounts[prefix] = [backend, block.mountpoint]
  }
  const index = buildIndexConfig(cfg.index)
  const stateStore = buildStateStore(cfg.store)
  const cliEntries =
    cfg.clis !== undefined && cfg.clis !== null
      ? await buildCliEntries(cfg.clis, sources)
      : undefined
  const runtimeEntries =
    cfg.runtimes !== undefined && cfg.runtimes !== null
      ? await buildRuntimeEntries(cfg.runtimes)
      : undefined
  return {
    mounts,
    options: {
      mode: wsMode,
      commandLimits: parseCommandLimits(cfg.commandLimits),
      ...(cfg.maxMemory !== undefined ? { maxMemory: cfg.maxMemory } : {}),
      ...(cfg.network !== undefined ? { network: cfg.network } : {}),
      ...(cfg.systemTime !== undefined ? { systemTime: cfg.systemTime } : {}),
      io: new IOConfig(cfg.io),
      read: defaultRead,
      write: defaultWrite,
      ...(cfg.defaultSessionId !== undefined ? { sessionId: cfg.defaultSessionId } : {}),
      ...(cfg.workspaceId !== undefined ? { workspaceId: cfg.workspaceId } : {}),
      ...(cfg.cache !== undefined && cfg.cache !== null ? { cache: cfg.cache } : {}),
      ...(index !== undefined ? { index } : {}),
      // Built here for this workspace alone, so it is the workspace's
      // to close — a redis or s3 store has a client that nothing else
      // would ever release. Mirrors the `owns_store` Python's loader
      // sets beside the same store.
      ...(stateStore !== undefined ? { store: stateStore, ownsStore: true } : {}),
      ...(runtimeEntries !== undefined ? { runtimes: runtimeEntries } : {}),
      ...(cfg.routePolicy !== undefined && cfg.routePolicy !== null
        ? { routePolicy: loadProgram(parseProgram(cfg.routePolicy, 'route_policy')) }
        : {}),
      ...(cfg.profiles !== undefined && cfg.profiles !== null
        ? {
            profiles: Object.fromEntries(
              Object.entries(parseProfiles(cfg.profiles)).map(([name, profile]) => [
                name,
                loadProfilePolicy(profile),
              ]),
            ),
          }
        : {}),
      ...(cfg.profile !== undefined && cfg.profile !== null
        ? { profile: cfg.profile as string }
        : {}),
      ...(cliEntries !== undefined ? { clis: cliEntries } : {}),
      // Passed through as-is: this entry point resolves mounts, and
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
async function resolveCliRef(ref: string, name: string): Promise<string | CLI> {
  if (!ref.includes(':')) return ref
  return asCliSpec(await loadAttr(ref), name, ref)
}

/** Validate the shared grammar and execution shape from another core copy. */
function looksLikeCliSpec(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const definition = value as Record<string, unknown>
  if (!isPlainObject(definition.handlers)) return false
  for (const handler of Object.values(definition.handlers)) {
    if (handler === null || typeof handler !== 'object') return false
    const binding = handler as Record<string, unknown>
    if (binding.fn !== null && typeof binding.fn !== 'function') return false
    if (typeof binding.write !== 'boolean') return false
  }
  const pending: unknown[] = [definition.spec]
  const seen = new Set<unknown>()
  while (pending.length > 0) {
    const candidate = pending.pop()
    if (candidate === null || typeof candidate !== 'object') return false
    if (seen.has(candidate)) continue
    seen.add(candidate)
    const node = candidate as Record<string, unknown>
    if (typeof node.name !== 'string' || node.name === '' || /\s/.test(node.name)) return false
    if (!Array.isArray(node.aliases) || !node.aliases.every((alias) => typeof alias === 'string'))
      return false
    if (!Array.isArray(node.arguments) || !Array.isArray(node.subcommands)) return false
    if (typeof node.addHelp !== 'boolean' || typeof node.allowAbbrev !== 'boolean') return false
    for (const argument of node.arguments) {
      if (argument === null || typeof argument !== 'object') return false
      const input = argument as Record<string, unknown>
      if (!Array.isArray(input.names) || !input.names.every((name) => typeof name === 'string'))
        return false
    }
    const subcommands: unknown[] = node.subcommands
    for (const item of subcommands) pending.push(item)
  }
  return true
}

/**
 * Check that a `cli:` reference resolved to a program tree.
 *
 * `instanceof` is the fast path, not the test. The referenced file lives
 * in someone else's project, which is the whole point of the ref form,
 * and that project may resolve its own copy of `@struktoai/mirage-core`:
 * a real CLI carrying every method, built off a different class
 * object. Demanding `instanceof` would refuse exactly the case this
 * exists to serve, so anything else is admitted on its shape instead,
 * and refused at create time rather than when an agent first types the
 * head word.
 */
function asCliSpec(value: unknown, name: string, ref: string): CLI {
  if (value instanceof CLI) return value
  if (looksLikeCliSpec(value)) return new CLI(value as CLI)
  throw new Error(`clis entry '${name}': ${ref} is not a CLI`)
}

async function buildCliEntries(
  clis: Record<string, CLIBlock>,
  sources?: Readonly<Record<string, ResolvedSource>>,
): Promise<Record<string, [string | CLI, Record<string, unknown> | null]>> {
  const out: Record<string, [string | CLI, Record<string, unknown> | null]> = {}
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
    // is synchronous. A `vfs:` value reads the same way, resolved by
    // `buildVfs` rather than here, because a mount block reaches the
    // registry and a `clis` block does not.
    const entry = hasScript
      ? new CLI({
          spec: new CommandSpec({ name }),
          script: loadScriptSource(block.script as string),
          runtime: block.runtime ?? null,
        })
      : await resolveCliRef(block.cli as string, name)
    // A CLI credential reads a pointer the way a mount's does: the
    // account CLI's `config_model` is the same model a VFS
    // parses, so it must receive the credential, not the pointer.
    out[name] = [
      entry,
      await resolveConfigSecrets(block.config ?? {}, sources, `clis.${name}.config`),
    ]
  }
  return out
}
