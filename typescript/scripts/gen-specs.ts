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

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as Browser from '@struktoai/mirage-browser'
import * as Core from '@struktoai/mirage-core'
import * as Node from '@struktoai/mirage-node'

import type { CommandSpec, Operand, Option, RegisteredCommand } from '@struktoai/mirage-core'

const { CommandSpec: SpecClass, Operand: OperandClass, Option: OptionClass } = Core

const __dirname = resolve(fileURLToPath(import.meta.url), '..')
const SPEC_ROOT = resolve(__dirname, '..', '..', 'spec', 'typescript')
const PACKAGES = resolve(__dirname, '..', 'packages')

// Bespoke Google Workspace API passthroughs. They register command names that
// are not in SPECS, so they contribute nothing to the spec dump and stay
// internal to the gws resource rather than being re-exported.
const UNEXPORTED_COMMAND_GROUPS: ReadonlySet<string> = new Set([
  'GWS_DOCS_API_COMMANDS',
  'GWS_DRIVE_API_COMMANDS',
  'GWS_GMAIL_API_COMMANDS',
  'GWS_SHEETS_API_COMMANDS',
  'GWS_SLIDES_API_COMMANDS',
])

type ModuleBag = Record<string, unknown>

function declaredCommandGroups(pkg: string): string[] {
  const root = resolve(PACKAGES, pkg, 'src', 'commands', 'builtin')
  const names: string[] = []
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
    for (const m of source.matchAll(/^export const ([A-Z0-9_]+_COMMANDS)\b/gm)) {
      names.push(m[1] as string)
    }
  }
  return names
}

// The registry below can only see command groups the package index re-exports.
// A backend that defines its commands but forgets the re-export silently drops
// out of the spec dump (and out of the cross-language parity check with it),
// so fail loudly instead of emitting a quietly incomplete spec.
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

function collectRegistrations(modules: ModuleBag[]): Record<string, RegisteredCommand[]> {
  const out: Record<string, RegisteredCommand[]> = {}
  for (const mod of modules) {
    for (const [key, value] of Object.entries(mod)) {
      if (!key.endsWith('_COMMANDS') || !Array.isArray(value)) continue
      for (const rc of value as RegisteredCommand[]) {
        if (!out[rc.name]) out[rc.name] = []
        out[rc.name].push(rc)
      }
    }
  }
  return out
}

// The union flags below cannot say *which* resource carries a provision, an
// aggregate, the write flag or a filetype, so dropping one backend's
// provision while another keeps it leaves every union unchanged. Key the same
// facts by resource so the parity check sees that difference.
function byResource(rcs: RegisteredCommand[]): Record<string, unknown> {
  const out: Record<
    string,
    { has_provision: boolean; has_aggregate: boolean; has_write: boolean; filetypes: Set<string> }
  > = {}
  for (const rc of rcs) {
    const key = rc.resource ?? ''
    const entry = (out[key] ??= {
      has_provision: false,
      has_aggregate: false,
      has_write: false,
      filetypes: new Set<string>(),
    })
    entry.has_provision ||= rc.provisionFn !== null
    entry.has_aggregate ||= rc.aggregate !== null
    entry.has_write ||= rc.write
    if (rc.filetype !== null) entry.filetypes.add(rc.filetype)
  }
  return Object.fromEntries(
    Object.entries(out).map(([key, entry]) => [
      key,
      { ...entry, filetypes: [...entry.filetypes].sort() },
    ]),
  )
}

function metaFor(rcs: RegisteredCommand[]): Record<string, unknown> {
  const resources = [
    ...new Set(rcs.map((r) => r.resource).filter((r): r is string => r !== null)),
  ].sort()
  const filetypes = [
    ...new Set(rcs.map((r) => r.filetype).filter((f): f is string => f !== null)),
  ].sort()
  return {
    by_resource: byResource(rcs),
    filetypes,
    has_aggregate: rcs.some((r) => r.aggregate !== null),
    has_provision: rcs.some((r) => r.provisionFn !== null),
    has_write: rcs.some((r) => r.write),
    resources,
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
    if (key !== 'type' && JSON.stringify(value) === JSON.stringify(defaults[key])) continue
    kept[key] = value
  }
  return kept
}

function operandFields(op: Operand): Record<string, unknown> {
  return { provided_by: [...op.providedBy], text_when: [...op.textWhen], type: op.type }
}

function serializeOperand(op: Operand): Record<string, unknown> {
  return prune(operandFields(op), operandFields(new OperandClass({})))
}

function optionFields(o: Option): Record<string, unknown> {
  return {
    choices: o.choices,
    count: o.count,
    default: o.default,
    description: o.description,
    long: o.long,
    multiple: o.multiple,
    numeric_shorthand: o.numericShorthand,
    pair: o.pair,
    required: o.required,
    short: o.short,
    short_value: o.shortValue,
    type: o.type,
    value_optional: o.valueOptional,
  }
}

function serializeOption(o: Option): Record<string, unknown> {
  return prune(optionFields(o), optionFields(new OptionClass({})))
}

function specFields(spec: CommandSpec): Record<string, unknown> {
  return {
    description: spec.description,
    epilog: spec.epilog,
    ignore_tokens: [...spec.ignoreTokens].sort(),
    old_option_style: spec.oldOptionStyle,
    operand_base: spec.operandBase,
    options: spec.options.map(serializeOption),
    positional: spec.positional.map(serializeOperand),
    rest: spec.rest === null ? null : serializeOperand(spec.rest),
  }
}

function serializeSpec(spec: CommandSpec, rcs: RegisteredCommand[]): Record<string, unknown> {
  return {
    ...prune(specFields(spec), specFields(new SpecClass({}))),
    _meta: metaFor(rcs),
  }
}

function sortedStringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      }
      return v
    },
    2,
  )
}

// The two resource-name sets the parity gate compares. `registry` is what
// `buildResource` can construct by name — the hand-maintained table that
// workspace YAML and snapshots go through. `command_resources` is what the
// spec tree already knew: every resource registering at least one builtin
// command. A name in the second but not the first registers commands yet
// cannot be mounted by name, which is how chroma/dify/lancedb/qdrant stayed
// unconstructible in typescript while appearing in every command's `_meta`.
function emitResources(
  name: string,
  knownResources: string[],
  registry: Record<string, RegisteredCommand[]>,
): void {
  const commandResources = new Set<string>()
  for (const rcs of Object.values(registry)) {
    for (const rc of rcs) if (rc.resource !== null) commandResources.add(rc.resource)
  }
  const payload = {
    registry: [...knownResources].sort(),
    command_resources: [...commandResources].sort(),
  }
  const path = resolve(SPEC_ROOT, name, 'resources.json')
  writeFileSync(path, sortedStringify(payload) + '\n')
  console.log(`emitted ${payload.registry.length} registry names to ${path}`)
}

function emitVariant(
  name: string,
  pkgs: readonly string[],
  modules: ModuleBag[],
  knownResources: string[],
): void {
  assertGroupsReachable(pkgs, modules)
  const registry = collectRegistrations(modules)
  const outDir = resolve(SPEC_ROOT, name, 'general')
  mkdirSync(outDir, { recursive: true })
  const cmdNames = Object.keys(Core.SPECS).sort()
  for (const cmd of cmdNames) {
    const spec = Core.SPECS[cmd]
    const rcs = registry[cmd] ?? []
    const payload = serializeSpec(spec, rcs)
    writeFileSync(resolve(outDir, `${cmd}.json`), sortedStringify(payload) + '\n')
  }
  console.log(`emitted ${cmdNames.length} specs to ${outDir}`)
  emitResources(name, knownResources, registry)
}

function main(): void {
  emitVariant(
    'node',
    ['core', 'node'],
    [Core as unknown as ModuleBag, Node as unknown as ModuleBag],
    Node.knownResources(),
  )
  emitVariant(
    'browser',
    ['core', 'browser'],
    [Core as unknown as ModuleBag, Browser as unknown as ModuleBag],
    Browser.knownResources(),
  )
}

main()
