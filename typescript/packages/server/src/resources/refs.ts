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

import type { ResourceStore } from '@struktoai/mirage-core/resources/base'
import { ENTRY_KINDS } from '@struktoai/mirage-core/resources/constants'
import { isPointer, storesOf, STRUKTO } from './values.ts'

/** The `{from: strukto, ref}` entries a config names, each once, in order. Mirrors the console's `secretRefs`. */
function secretRefs(config: unknown): string[] {
  const found: string[] = []
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(walk)
      return
    }
    if (v === null || typeof v !== 'object') return
    const o = v as Record<string, unknown>
    if (o.from === STRUKTO && typeof o.ref === 'string') {
      if (!found.includes(o.ref)) found.push(o.ref)
      return
    }
    Object.values(o).forEach(walk)
  }
  walk(config)
  return found
}

/** The stores a config's `{from: <store>, ref, key}` pointers name, each once, in order. Mirrors the console's `storeRefs`. */
function storeRefs(config: unknown): string[] {
  const found: string[] = []
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(walk)
      return
    }
    if (v === null || typeof v !== 'object') return
    if (isPointer(v)) {
      if (v.from !== STRUKTO && !found.includes(v.from)) found.push(v.from)
      return
    }
    Object.values(v).forEach(walk)
  }
  walk(config)
  return found
}

/** The stores each entry's fields point at, by the entry's name. */
export async function entryStores(store: ResourceStore): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  for (const kind of ENTRY_KINDS) {
    for (const entry of await store.listEntries(kind)) out.set(entry.name, storesOf(entry.fields))
  }
  return out
}

/**
 * The saved templates whose config names each entry, by the entry's name: a
 * store's are those naming it, or naming an entry whose fields point at it.
 * The daemon keeps no live workspace to count, so a saved template is what
 * refers to an entry.
 */
export async function uses(store: ResourceStore): Promise<Map<string, string[]>> {
  const through = await entryStores(store)
  const out = new Map<string, string[]>()
  const add = (entry: string, template: string): void => {
    const names = out.get(entry)
    if (names === undefined) out.set(entry, [template])
    else if (!names.includes(template)) names.push(template)
  }
  for (const template of await store.listTemplates()) {
    for (const ref of secretRefs(template.config)) {
      add(ref, template.name)
      for (const source of through.get(ref) ?? []) add(source, template.name)
    }
    for (const source of storeRefs(template.config)) add(source, template.name)
  }
  return out
}
