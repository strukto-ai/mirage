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

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as Browser from '@struktoai/mirage-browser'
import * as Node from '@struktoai/mirage-node'

import {
  CommandSpec as SpecClass,
  Argument as ArgumentClass,
  SPECS,
} from '@struktoai/mirage-core/commands/spec/index'

import type { Argument, CommandSpec } from '@struktoai/mirage-core/commands/spec/index'
import type { Command } from '@struktoai/mirage-core/commands/config'

import {
  type Capabilities,
  type ConfigFacts,
  configFacts,
  registryCapabilities,
} from './vfs_facts.ts'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')
const SPEC_ROOT = resolve(
  process.env.MIRAGE_SPEC_DIR ?? resolve(__dirname, '..', '..', '.cache', 'spec'),
  'typescript',
)
const PACKAGES = resolve(__dirname, '..', 'packages')

// Bespoke Google Workspace API passthroughs. They register command names that
// are not in SPECS, so they contribute nothing to the spec dump and stay
// internal to the gws VFS rather than being re-exported.
const UNEXPORTED_COMMAND_GROUPS: ReadonlySet<string> = new Set([
  'GWS_DOCS_API_COMMANDS',
  'GWS_DRIVE_API_COMMANDS',
  'GWS_GMAIL_API_COMMANDS',
  'GWS_SHEETS_API_COMMANDS',
  'GWS_SLIDES_API_COMMANDS',
])

type ModuleBag = Record<string, unknown>

function commandGroupDirs(pkg: string): { dir: string; groups: string[] }[] {
  const root = resolve(PACKAGES, pkg, 'src', 'commands', 'builtin')
  const out: { dir: string; groups: string[] }[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    let source: string
    try {
      source = readFileSync(resolve(root, entry.name, 'index.ts'), 'utf8')
    } catch (err) {
      // A directory with no index.ts declares no command group. Any other
      // read failure means the scan is incomplete, which is exactly when
      // the reachability assertion below must not be trusted.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
    const groups = [...source.matchAll(/^export const ([A-Z0-9_]+_COMMANDS)\b/gm)].map(
      (m) => m[1] as string,
    )
    if (groups.length > 0) out.push({ dir: entry.name, groups })
  }
  return out
}

function declaredCommandGroups(pkg: string): string[] {
  return commandGroupDirs(pkg).flatMap((d) => d.groups)
}

// core ships as a module tree, so its groups are read from the modules that
// declare them rather than from whatever the package index happens to name.
// Nothing can go missing here: the directory scan is the source of truth.
async function coreCommandGroups(): Promise<ModuleBag> {
  const bag: ModuleBag = {}
  for (const { dir } of commandGroupDirs('core')) {
    const mod = (await import(`@struktoai/mirage-core/commands/builtin/${dir}/index`)) as ModuleBag
    for (const [key, value] of Object.entries(mod)) {
      if (key.endsWith('_COMMANDS')) bag[key] = value
    }
  }
  return bag
}

// node and browser are still bundled behind a single entry, so their registry
// can only see command groups the package index re-exports. A backend that
// defines its commands but forgets the re-export silently drops out of the
// spec dump (and out of the cross-language parity check with it), so fail
// loudly instead of emitting a quietly incomplete spec.
function assertGroupsReachable(pkgs: readonly string[], modules: ModuleBag[]): void {
  const reachable = new Set(modules.flatMap((m) => Object.keys(m)))
  const missing: string[] = []
  for (const pkg of pkgs) {
    for (const name of declaredCommandGroups(pkg)) {
      if (reachable.has(name) || UNEXPORTED_COMMAND_GROUPS.has(name)) continue
      missing.push(`${name} (packages/${pkg})`)
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `command groups are not re-exported from their package index, so their ` +
        `registrations are invisible to the spec dump: ${missing.join(', ')}`,
    )
  }
}

function collectRegistrations(modules: ModuleBag[]): Record<string, Command[]> {
  const out: Record<string, Command[]> = {}
  for (const mod of modules) {
    for (const [key, value] of Object.entries(mod)) {
      if (!key.endsWith('_COMMANDS') || !Array.isArray(value)) continue
      for (const rc of value as Command[]) {
        ;(out[rc.name] ??= []).push(rc)
      }
    }
  }
  return out
}

// The union flags below cannot say *which* VFS carries an aggregate, the
// write flag or a filetype, so dropping one backend's aggregate while another
// keeps it leaves every union unchanged. Key the same facts by VFS so the
// parity check sees that difference.
function byVfs(rcs: Command[]): Record<string, unknown> {
  const out: Record<
    string,
    { has_aggregate: boolean; has_write: boolean; filetypes: Set<string> }
  > = {}
  for (const rc of rcs) {
    const key = rc.vfs ?? ''
    const entry = (out[key] ??= {
      has_aggregate: false,
      has_write: false,
      filetypes: new Set<string>(),
    })
    entry.has_aggregate ||= rc.aggregate !== null
    entry.has_write ||= rc.write
    if (rc.filetype !== null) entry.filetypes.add(rc.filetype)
  }
  return Object.fromEntries(
    Object.entries(out).map(([key, entry]) => [
      key,
      { ...entry, filetypes: [...entry.filetypes].sort(compareCodePoints) },
    ]),
  )
}

function metaFor(rcs: Command[]): Record<string, unknown> {
  const vfsNames = [...new Set(rcs.map((r) => r.vfs).filter((r): r is string => r !== null))].sort(
    compareCodePoints,
  )
  const filetypes = [
    ...new Set(rcs.map((r) => r.filetype).filter((f): f is string => f !== null)),
  ].sort(compareCodePoints)
  return {
    by_vfs: byVfs(rcs),
    filetypes,
    has_aggregate: rcs.some((r) => r.aggregate !== null),
    has_write: rcs.some((r) => r.write),
    vfs_names: vfsNames,
  }
}

// A spec dump is a cross-language contract, and restating every default
// in all 93 files buries the handful of facts each command actually
// declares. Anything equal to what a default-constructed instance would
// have carried is dropped, so the defaults come from the class rather
// than a table that could drift from it. `type` survives even at its
// default, because what a token *is* is the first thing a reader looks
// for. Python's `_prune` does the same against its dataclass fields; the
// two must drop exactly the same keys or the parity gate reports every
// command.
function prune(
  full: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(full)) {
    if (
      key !== 'type' &&
      key !== 'names' &&
      JSON.stringify(value) === JSON.stringify(defaults[key])
    )
      continue
    kept[key] = value
  }
  return kept
}

function snakeFields(value: Argument | CommandSpec): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      field instanceof Set ? [...field].sort(compareCodePoints) : field,
    ]),
  )
}

function serializeArgument(argument: Argument): Record<string, unknown> {
  return prune(snakeFields(argument), snakeFields(new ArgumentClass('__default__')))
}

function specFields(spec: CommandSpec): Record<string, unknown> {
  return {
    ...snakeFields(spec),
    ignore_tokens: [...spec.ignoreTokens].sort(compareCodePoints),
    // Parsing and help preserve order within the option/positional partitions.
    arguments: [...spec.arguments]
      .sort((a, b) => Number(!a.names[0]?.startsWith('-')) - Number(!b.names[0]?.startsWith('-')))
      .map(serializeArgument),
    subcommands: spec.subcommands.map((child) =>
      prune(specFields(child), specFields(new SpecClass({}))),
    ),
  }
}

function serializeSpec(spec: CommandSpec, rcs: Command[]): Record<string, unknown> {
  return {
    ...prune(specFields(spec), specFields(new SpecClass({}))),
    _meta: metaFor(rcs),
  }
}

function cliSpecs(module: ModuleBag): Record<string, unknown> {
  return Object.fromEntries(
    Object.values(module)
      .filter((value): value is Node.CLI => value instanceof Node.CLI)
      .map((cli) => [
        cli.spec.name,
        {
          grammar: prune(specFields(cli.spec), specFields(new SpecClass({}))),
          handlers: Object.fromEntries(
            Object.entries(cli.handlers).map(([path, handler]) => [
              path,
              {
                write: handler.write,
                limit:
                  handler.limit === null
                    ? null
                    : {
                        max_bytes: handler.limit.maxBytes,
                        max_lines: handler.limit.maxLines,
                        timeout_seconds: handler.limit.timeoutSeconds,
                        on_exceed: handler.limit.onExceed,
                      },
              },
            ]),
          ),
          config_model: cli.configModel !== null,
        },
      ]),
  )
}

// Codepoint compare, not `localeCompare` and not the default comparator:
// python's `sorted` and `json.dumps(sort_keys=True)` order by code point,
// so `scripts/gen_specs.py` and this generator must use the same rule or
// the two spec trees a human diffs carry ordering noise on top of real
// drift. `localeCompare` with no locale argument also reads the runtime's
// ICU data, which makes pre-commit's Spec drift step machine-dependent.
// Inlined rather than imported from `@struktoai/mirage-core/utils/sort`
// because a script runs before any package is built.
function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const aPoint = a.codePointAt(i) ?? 0
    const bPoint = b.codePointAt(j) ?? 0
    if (aPoint !== bPoint) return aPoint - bPoint
    i += aPoint > 0xffff ? 2 : 1
    j += bPoint > 0xffff ? 2 : 1
  }
  return a.length - i - (b.length - j)
}

function sortedStringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => compareCodePoints(a, b)),
        )
      }
      return v
    },
    2,
  )
}

// The two VFS-name sets the parity gate compares. `registry` is what
// `buildVfs` can construct by name — the hand-maintained table that
// workspace YAML and snapshots go through. `command_vfs_names` is what the
// spec tree already knew: every VFS registering at least one builtin
// command. A name in the second but not the first registers commands yet
// cannot be mounted by name, which is how chroma/dify/lancedb/qdrant stayed
// unconstructible in typescript while appearing in every command's `_meta`.
//
// `capabilities` carries the values behind those names. Registry membership
// only says a backend can be built; how it behaves is a second
// hand-maintained surface that drifted just as quietly — Python served
// ten-minute-stale listings of a live postgres schema because its
// `index_ttl` kept the 600 s default where typescript pinned 0, and box's
// `du` was defined on one side and absent on the other.
function emitVfsNames(
  name: string,
  knownVfsNames: string[],
  registry: Record<string, Command[]>,
  capabilities: Record<string, Capabilities | null>,
  configs: Record<string, ConfigFacts | null>,
  programs: Record<string, unknown>,
): void {
  const commandVfsNames = new Set<string>()
  for (const rcs of Object.values(registry)) {
    for (const rc of rcs) if (rc.vfs !== null) commandVfsNames.add(rc.vfs)
  }
  const payload = {
    registry: [...knownVfsNames].sort(compareCodePoints),
    command_vfs_names: [...commandVfsNames].sort(compareCodePoints),
    capabilities,
    configs,
    cli_specs: programs,
  }
  const path = resolve(SPEC_ROOT, name, 'vfs.json')
  writeFileSync(path, sortedStringify(payload) + '\n')
  console.log(`emitted ${payload.registry.length} registry names to ${path}`)
}

// Every registered command SPECS does not declare. A backend verb (`trello
// card create`) carries its spec inline, so the SPECS loop never sees it and
// the parity gate could not tell a flag one language dropped. Each name gets
// the spec its registrations share; two registrations of one name with
// different specs is itself a failure. The directory is rewritten whole so a
// removed verb leaves no file behind. Mirrors `_emit_vfs_commands` in
// scripts/gen_specs.py.
function emitVfsCommands(name: string, registry: Record<string, Command[]>): void {
  const outDir = resolve(SPEC_ROOT, name, 'vfs_commands')
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  for (const stale of readdirSync(outDir)) {
    if (stale.endsWith('.json')) rmSync(resolve(outDir, stale))
  }
  const own = Object.entries(registry)
    .filter(([cmd]) => !(cmd in SPECS))
    .sort(([a], [b]) => compareCodePoints(a, b))
  for (const [cmd, rcs] of own) {
    const first = rcs[0]
    if (first === undefined) continue
    const payloads = new Set(rcs.map((rc) => sortedStringify(serializeSpec(rc.spec, []))))
    if (payloads.size > 1) {
      throw new Error(`'${cmd}' is registered with ${String(payloads.size)} different specs`)
    }
    const payload = serializeSpec(first.spec, rcs)
    writeFileSync(
      resolve(outDir, `${cmd.replaceAll(' ', '_')}.json`),
      sortedStringify(payload) + '\n',
    )
  }
  console.log(`emitted ${own.length} backend command specs to ${outDir}`)
}

function emitVariant(
  name: string,
  pkgs: readonly string[],
  modules: ModuleBag[],
  knownVfsNames: string[],
): void {
  // core is in `pkgs` because its source is scanned for capabilities and
  // CommandIO facts, but only the runtime package is asserted reachable:
  // core's groups came from the directory scan, which cannot miss one.
  assertGroupsReachable([pkgs[pkgs.length - 1] as string], modules)
  const registry = collectRegistrations(modules)
  const outDir = resolve(SPEC_ROOT, name, 'general')
  mkdirSync(outDir, { recursive: true })
  for (const stale of readdirSync(outDir)) {
    if (stale.endsWith('.json')) rmSync(resolve(outDir, stale))
  }
  // Entries, not keys: a key read back through `SPECS[cmd]` is
  // `CommandSpec | undefined` under `noUncheckedIndexedAccess`, and the only
  // ways to spend that are a cast or a skip that would emit fewer specs than
  // it reported. Pairing the two removes the possibility instead.
  const entries = Object.entries(SPECS).sort(([a], [b]) => compareCodePoints(a, b))
  for (const [cmd, spec] of entries) {
    const rcs = registry[cmd] ?? []
    const payload = serializeSpec(spec, rcs)
    writeFileSync(resolve(outDir, `${cmd}.json`), sortedStringify(payload) + '\n')
  }
  console.log(`emitted ${entries.length} specs to ${outDir}`)
  emitVfsCommands(name, registry)
  emitVfsNames(
    name,
    knownVfsNames,
    registry,
    registryCapabilities(PACKAGES, pkgs),
    configFacts(
      resolve(PACKAGES, pkgs[pkgs.length - 1] as string, 'src', 'vfs', 'registry.ts'),
      PACKAGES,
    ),
    cliSpecs(modules[modules.length - 1] as ModuleBag),
  )
}

async function main(): Promise<void> {
  const core = await coreCommandGroups()
  emitVariant('node', ['core', 'node'], [core, Node as unknown as ModuleBag], Node.knownVfsNames())
  emitVariant(
    'browser',
    ['core', 'browser'],
    [core, Browser as unknown as ModuleBag],
    Browser.knownVfsNames(),
  )
}

await main()
