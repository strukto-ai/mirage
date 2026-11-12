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

import { compareCodePoints } from '../utils/sort.ts'
import { MachineHandle } from './handle.ts'

/** A provider's handle class, built from a machine's name and config. */
export type MachineClass = (new (name: string, config?: never) => MachineHandle) &
  Pick<typeof MachineHandle, 'configFields'>

// Null prototype: provider names come from config, and a name like
// `constructor` must miss instead of resolving an `Object.prototype` member.
const PROVIDERS: Record<string, MachineClass> = Object.create(null) as Record<string, MachineClass>

// The providers @struktoai/mirage-node registers when it is imported.
const NODE_PROVIDERS: readonly string[] = [
  'apple_container',
  'daytona',
  'docker',
  'kubernetes',
  'microsandbox',
  'smolvm',
  'ssh',
]

/**
 * Register a provider's handle class. Each provider module calls it as it
 * loads: e2b's and cloudflare_container's in core, the rest in
 * @struktoai/mirage-node. Python reaches its providers by module path
 * (`MACHINE_MODULES`) instead.
 *
 * @param provider the name a `machines:` entry's `provider` spells.
 * @param cls the handle class.
 */
export function registerMachine(provider: string, cls: MachineClass): void {
  PROVIDERS[provider] = cls
}

/** Every provider a `machines:` entry may name. Mirrors Python's `known_providers`. */
export function knownProviders(): string[] {
  return Object.keys(PROVIDERS).sort(compareCodePoints)
}

/**
 * The handle class a provider names. Mirrors Python's `machine_class`.
 *
 * Throws:
 *   Error: an unknown provider, with a hint for one another package
 *   registers.
 */
export function machineClass(provider: string): MachineClass {
  const cls = PROVIDERS[provider]
  if (cls !== undefined) return cls
  if (NODE_PROVIDERS.includes(provider))
    throw new Error(
      `machine provider '${provider}' lives in @struktoai/mirage-node; import that package to register it`,
    )
  const known = knownProviders()
    .map((p) => `'${p}'`)
    .join(', ')
  throw new Error(`unknown machine provider: '${provider}' (expected one of ${known})`)
}

/**
 * The machine one `machines:` entry describes: a handle as given, or its
 * `provider` built with the entry's other keys as its config. Mirrors
 * Python's `build_machine`.
 *
 * @param name the entry's name.
 * @param spec a handle, or the entry as config spells it.
 */
export function buildMachine(
  name: string,
  spec: MachineHandle | Record<string, unknown>,
): MachineHandle {
  if (spec instanceof MachineHandle) {
    if (spec.name !== name) throw new Error(`machine '${name}' is a handle named '${spec.name}'`)
    return spec
  }
  const { provider, ...fields } = spec
  if (typeof provider !== 'string' || provider === '')
    throw new Error(`machine '${name}' needs a provider`)
  return new (machineClass(provider))(name, fields as never)
}
