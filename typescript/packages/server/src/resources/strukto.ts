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

import type { WorkspaceConfigRaw } from '@struktoai/mirage-core/config'
import type { ResourceStore } from '@struktoai/mirage-core/resources/base'
import { ENTRY_KINDS, STRUKTO } from '@struktoai/mirage-core/resources/constants'
import { ResourceError } from '@struktoai/mirage-core/resources/errors'
import type { EntryKind } from '@struktoai/mirage-core/resources/types'
import { SecretsError } from '@struktoai/mirage-core/secrets/errors'
import type { ResolvedSecret } from '@struktoai/mirage-core/secrets/types'
import type { JsonValue } from '@struktoai/mirage-core/types'
import { z } from '@struktoai/mirage-core/vfs/secrets'

/** The `strukto` secrets source's config: each saved entry a workspace's config names, field by field. */
export const StruktoSourceConfig = z.object({
  entries: z.record(z.string(), z.record(z.string(), z.string())),
})
export type StruktoSourceConfig = z.infer<typeof StruktoSourceConfig>

/** The fields of the saved entry `ref`, as a workspace was handed them. */
export function fetchStrukto(config: StruktoSourceConfig, ref: string): Promise<ResolvedSecret> {
  const fields = Object.hasOwn(config.entries, ref) ? config.entries[ref] : undefined
  if (fields === undefined) return Promise.reject(new SecretsError(`no saved entry named '${ref}'`))
  return Promise.resolve({ fields })
}

/** A field's value as a secret's field holds it: a string as it is, a list joined by commas, anything else as JSON. */
function flat(value: JsonValue): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(flat).join(',')
  return JSON.stringify(value)
}

/**
 * The config with the saved entries its `{from: strukto, ref, key}`
 * pointers name declared as the `strukto` source, sealed fields opened, so
 * mirage reads each pointer as it reads any secret's. A saved field never
 * points at a store, since a save refuses one.
 */
export async function withEntries(
  store: ResourceStore,
  cfg: WorkspaceConfigRaw,
  refs: readonly string[],
): Promise<WorkspaceConfigRaw> {
  const kinds = new Map<string, EntryKind>()
  for (const kind of ENTRY_KINDS) {
    for (const entry of await store.listEntries(kind)) kinds.set(entry.name, kind)
  }
  const entries: Record<string, Record<string, string>> = {}
  for (const ref of refs) {
    const kind = kinds.get(ref)
    if (kind === undefined) {
      throw new ResourceError('invalid', `${ref} is not saved as a VFS, CLI or runtime`)
    }
    const entry = await store.revealEntry(kind, ref)
    entries[ref] = Object.fromEntries(
      Object.entries({ ...entry.fields, ...entry.sealed }).map(([k, v]) => [k, flat(v)]),
    )
  }
  return {
    ...cfg,
    secrets: { ...(cfg.secrets ?? {}), [STRUKTO]: { source: STRUKTO, config: { entries } } },
  }
}
