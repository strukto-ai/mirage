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

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as Browser from '@struktoai/mirage-browser'
import * as Core from '@struktoai/mirage-core'
import * as Node from '@struktoai/mirage-node'

import type { CommandSpec, Operand, Option, RegisteredCommand } from '@struktoai/mirage-core'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')
const SPEC_ROOT = resolve(__dirname, '..', '..', 'spec', 'typescript')

type ModuleBag = Record<string, unknown>

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

function metaFor(rcs: RegisteredCommand[]): Record<string, unknown> {
  const resources = [
    ...new Set(rcs.map((r) => r.resource).filter((r): r is string => r !== null)),
  ].sort()
  const filetypes = [
    ...new Set(rcs.map((r) => r.filetype).filter((f): f is string => f !== null)),
  ].sort()
  return {
    filetypes,
    has_aggregate: rcs.some((r) => r.aggregate !== null),
    has_provision: rcs.some((r) => r.provisionFn !== null),
    has_write: rcs.some((r) => r.write),
    resources,
  }
}

function serializeOperand(op: Operand): Record<string, unknown> {
  return { kind: op.kind, provided_by: [...op.providedBy] }
}

function serializeOption(o: Option): Record<string, unknown> {
  return {
    description: o.description,
    long: o.long,
    numeric_shorthand: o.numericShorthand,
    repeatable: o.repeatable,
    short: o.short,
    value_kind: o.valueKind,
  }
}

function serializeSpec(spec: CommandSpec, rcs: RegisteredCommand[]): Record<string, unknown> {
  return {
    _meta: metaFor(rcs),
    description: spec.description,
    ignore_tokens: [...spec.ignoreTokens].sort(),
    options: spec.options.map(serializeOption),
    positional: spec.positional.map(serializeOperand),
    rest: spec.rest === null ? null : serializeOperand(spec.rest),
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

function emitVariant(name: string, modules: ModuleBag[]): void {
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
}

function main(): void {
  emitVariant('node', [Core as unknown as ModuleBag, Node as unknown as ModuleBag])
  emitVariant('browser', [Core as unknown as ModuleBag, Browser as unknown as ModuleBag])
}

main()
