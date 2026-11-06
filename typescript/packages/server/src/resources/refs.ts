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
import { STRUKTO } from './values.ts'

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

/**
 * The saved templates whose config names each entry, by the entry's name.
 * The daemon keeps no live workspace to count, so a saved template is what
 * refers to an entry.
 */
export async function uses(store: ResourceStore): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  for (const template of await store.listTemplates()) {
    for (const ref of secretRefs(template.config)) {
      const names = out.get(ref)
      if (names === undefined) out.set(ref, [template.name])
      else if (!names.includes(template.name)) names.push(template.name)
    }
  }
  return out
}
