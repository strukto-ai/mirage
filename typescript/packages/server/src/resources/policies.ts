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
import { POLICY_NAME } from '@struktoai/mirage-core/resources/constants'
import { ResourceError } from '@struktoai/mirage-core/resources/errors'
import type { JsonObject } from '@struktoai/mirage-core/types'
import { isRecord } from '@struktoai/mirage-core/utils/records'

/**
 * `written` with each profile program whose `script` names a saved policy
 * given that policy's source, so `script: guard.py` in a template means the
 * saved policy here as on the console. A script naming no saved policy stays
 * a path; `written` comes back as it is when no script changes.
 */
export async function withPolicies<T extends JsonObject>(
  store: ResourceStore,
  written: T,
): Promise<T> {
  const profiles = written.profiles
  if (!isRecord(profiles)) return written
  // Each name is read once; null keeps one that is not saved.
  const saved = new Map<string, string | null>()
  const sourceOf = async (name: string): Promise<string | null> => {
    if (!saved.has(name)) {
      try {
        saved.set(name, (await store.getPolicy(name)).source)
      } catch (e) {
        if (!(e instanceof ResourceError) || e.code !== 'not_found') throw e
        saved.set(name, null)
      }
    }
    return saved.get(name) ?? null
  }
  let changed = false
  const out: JsonObject = {}
  for (const [name, profile] of Object.entries(profiles)) {
    if (!isRecord(profile) || !isRecord(profile.policy)) {
      out[name] = profile
      continue
    }
    const policy: JsonObject = {}
    for (const [method, programs] of Object.entries(profile.policy)) {
      if (!Array.isArray(programs)) {
        policy[method] = programs
        continue
      }
      const swapped: unknown[] = []
      for (const program of programs) {
        const script = isRecord(program) ? program.script : undefined
        if (typeof script === 'string' && POLICY_NAME.test(script)) {
          const source = await sourceOf(script)
          if (source !== null) {
            swapped.push({ ...(program as JsonObject), script: { source, language: 'python' } })
            changed = true
            continue
          }
        }
        swapped.push(program)
      }
      policy[method] = swapped
    }
    out[name] = { ...profile, policy }
  }
  return changed ? { ...written, profiles: out } : written
}
