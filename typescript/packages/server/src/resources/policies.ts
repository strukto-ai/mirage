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
import { ResourceError } from '@struktoai/mirage-core/resources/errors'
import type { JsonValue } from '@struktoai/mirage-core/types'

/** A saved policy's name: a file name mirage reads as Python. */
export const POLICY_NAME = /^[a-z0-9][a-z0-9._-]{0,59}\.py$/

type Json = Record<string, JsonValue>

const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * `written` with each profile program whose `script` names a saved policy
 * given that policy's source, so `script: guard.py` in a template means the
 * saved policy here as on the console. A script naming no saved policy stays
 * a path; `written` comes back as it is when no script changes.
 */
export async function withPolicies(store: ResourceStore, written: Json): Promise<Json> {
  const profiles = written.profiles
  if (!isObject(profiles)) return written
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
  const out: Json = {}
  for (const [name, profile] of Object.entries(profiles)) {
    if (!isObject(profile) || !isObject(profile.policy)) {
      out[name] = profile
      continue
    }
    const policy: Json = {}
    for (const [method, programs] of Object.entries(profile.policy)) {
      if (!Array.isArray(programs)) {
        policy[method] = programs
        continue
      }
      const swapped: JsonValue[] = []
      for (const program of programs) {
        const script = isObject(program) ? program.script : undefined
        if (typeof script === 'string' && POLICY_NAME.test(script)) {
          const source = await sourceOf(script)
          if (source !== null) {
            swapped.push({ ...(program as Json), script: { source, language: 'python' } })
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
