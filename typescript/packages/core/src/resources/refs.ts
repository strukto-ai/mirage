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

import { EnvVar } from '../secrets/config.ts'
import { isConfigPointer } from '../secrets/sources.ts'
import { isPlainObject } from '../utils/records.ts'
import { STRUKTO } from './constants.ts'
import type { Template } from './types.ts'

/** Whether an `env` block's entry is a managed one, `{from, ref, key?, readonly?, fetch?}`. */
function managed(entry: Record<string, unknown>): boolean {
  return Object.hasOwn(entry, 'from') && EnvVar.safeParse(entry).success
}

/**
 * The saved entries a config names, each once, in order: through a
 * `{from: strukto, ref, key}` pointer, or a managed entry of an `env` block,
 * whose `key` is optional. A pointer counts by the rule the secrets layer
 * reads one by, and a managed entry only as an `env` block's entry, so a
 * runtime's `env` map holding `from` and `ref` is neither.
 */
export function secretRefs(config: unknown): string[] {
  const found: string[] = []
  const walk = (v: unknown, env = false): void => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item)
      return
    }
    if (!isPlainObject(v)) return
    if (isConfigPointer(v) || (env && managed(v))) {
      const ref = v.ref
      if (v.from === STRUKTO && typeof ref === 'string' && ref !== '' && !found.includes(ref)) {
        found.push(ref)
      }
      return
    }
    for (const [name, item] of Object.entries(v)) {
      if (name === 'env' && isPlainObject(item)) {
        for (const entry of Object.values(item)) walk(entry, true)
      } else {
        walk(item)
      }
    }
  }
  walk(config)
  return found
}

/** The templates whose config names each entry, by the entry's name. */
export function usesOf(templates: readonly Template[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const template of templates) {
    for (const ref of secretRefs(template.config)) {
      const names = out.get(ref)
      if (names === undefined) out.set(ref, [template.name])
      else if (!names.includes(template.name)) names.push(template.name)
    }
  }
  return out
}
