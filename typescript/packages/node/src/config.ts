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

import type {
  PolicyMethod,
  ProfileScript,
  ProfileScripts,
} from '@struktoai/mirage-core/policy/types'
import { METHODS } from '@struktoai/mirage-core/policy/constants'
import { compileProgram, parseProgram } from '@struktoai/mirage-core/policy/profile'
import {
  buildCliEntries as buildCliEntriesFor,
  checkWorkspaceConfig,
  configToWorkspaceArgs as configToWorkspaceArgsFor,
  interpolateEnv,
  isScriptPath,
  loadProfilePolicy as loadProfilePolicyFor,
  loadProgram,
  normalizeConfigKeys,
  readProcessEnv,
  type ConfigHost,
  type StoreBlock,
  type StoreGroupBlock,
  type WorkspaceConfigRaw,
} from '@struktoai/mirage-core/config'
import type { SessionProfile } from '@struktoai/mirage-core/policy/profile'
import type { ResolvedSource } from '@struktoai/mirage-core/secrets/types'
import type { CLI } from '@struktoai/mirage-core/commands/cli/types'
import { snakeToCamel } from '@struktoai/mirage-core/utils/normalize'
import { isPlainObject } from '@struktoai/mirage-core/utils/records'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import { parseConfigWithSchema } from '@struktoai/mirage-core/vfs/secrets'
import type { WorkspaceStateStore } from '@struktoai/mirage-core/workspace/store/base'
import { RAMWorkspaceStateStore } from '@struktoai/mirage-core/workspace/store/ram'
import { S3WorkspaceStateStore } from '@struktoai/mirage-core/workspace/store/s3'
import { readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
// The config loader is a workspace entry point of its own (the daemon
// builds from here), so it arms the builtin secrets sources like the
// node Workspace module does.
import './secrets/constants.ts'
import { releaseNetwork, watchNetwork } from './io/network.ts'
import { isModulePath, loadAttr, splitRef } from './utils/loader.ts'
import { parseYaml } from './utils/yaml.ts'
import { buildVfs } from './vfs/registry.ts'
import { S3Config } from '@struktoai/mirage-core/vfs/direct/s3'
import { DiskWorkspaceStateStore } from './workspace/store/disk.ts'
import { RedisWorkspaceStateStore } from './workspace/store/redis.ts'

export {
  checkWorkspaceConfig,
  interpolateEnv,
  loadWorkspaceConfig,
  readProcessEnv,
  type MountBlock,
  type WorkspaceConfigRaw,
} from '@struktoai/mirage-core/config'

/**
 * Node as a config host: scripts and `source:Name` references are read
 * from disk, mounts build from Node's VFS table, a `store:` block may name
 * disk, redis or s3, and a network rule watches Node's sockets.
 */
const HOST: ConfigHost = {
  buildVfs,
  buildStateStore,
  readScript: (path) => readFileSync(path, 'utf-8'),
  loadRef: loadAttr,
  watchNetwork,
  releaseNetwork,
}

/** Load a profile's path-form policy programs into ScriptSources, from disk. */
export function loadProfilePolicy(profile: SessionProfile): SessionProfile {
  return loadProfilePolicyFor(profile, HOST)
}

/** The mounts and options a config names, built on Node. */
export async function configToWorkspaceArgs(
  cfg: WorkspaceConfigRaw,
): ReturnType<typeof configToWorkspaceArgsFor> {
  return configToWorkspaceArgsFor(cfg, HOST)
}

/** Each `clis:` entry checked and resolved to its tree and its config, on Node. */
export async function buildCliEntries(
  clis: Readonly<Record<string, unknown>>,
  sources?: Readonly<Record<string, ResolvedSource>>,
): Promise<Record<string, [string | CLI, Record<string, unknown> | null]>> {
  return buildCliEntriesFor(clis, sources, HOST)
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
      return compileProgram(loadProgram(parsed, HOST), basename(path))
    })
  }
  return scripts
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
