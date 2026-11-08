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
import type { EntryKind, Fields } from '@struktoai/mirage-core/resources/types'
import { SecretsError } from '@struktoai/mirage-core/secrets/errors'
import { isConfigPointer } from '@struktoai/mirage-core/secrets/sources'
import type { ResolvedSecret } from '@struktoai/mirage-core/secrets/types'
import type { JsonValue } from '@struktoai/mirage-core/types'
import { z } from '@struktoai/mirage-core/vfs/secrets'
import { checkConfig } from '../schemas.ts'

/** The `strukto` secrets source's config: the fields of each saved entry a workspace's config names, the sealed ones opened. */
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

/** A saved value as a secret's field holds it: a string as it is, anything else as JSON. */
function flat(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** `value` with each `{from: strukto, ref, key}` that names a plain field replaced by the field's value, its type kept. */
function inline(value: unknown, plain: ReadonlyMap<string, Fields>): unknown {
  if (Array.isArray(value)) return value.map((item) => inline(item, plain))
  if (value === null || typeof value !== 'object') return value
  const o = value as Record<string, unknown>
  if (isConfigPointer(o)) {
    const fields = typeof o.ref === 'string' ? plain.get(o.ref) : undefined
    const key = o.key as string
    if (o.from === STRUKTO && fields !== undefined && Object.hasOwn(fields, key)) return fields[key]
    return o
  }
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, inline(v, plain)]))
}

/**
 * The config to build, with the saved entries its `{from: strukto, ref,
 * key}` pointers name filled in. A pointer at a plain field becomes the
 * field's value, so a list stays a list; one at a sealed field, and a managed
 * `env` entry at any field, reads it from the `strukto` source, declared here
 * with each entry's fields and the sealed ones opened, as mirage reads any
 * secret's. A saved field never points at a store, since a save refuses one. Throws a ResourceError for a name not saved as a VFS, CLI
 * or runtime, or a saved value its field cannot take.
 */
export async function withEntries(
  store: ResourceStore,
  written: Record<string, JsonValue>,
  refs: readonly string[],
): Promise<WorkspaceConfigRaw> {
  const kinds = new Map<string, EntryKind>()
  for (const kind of ENTRY_KINDS) {
    for (const entry of await store.listEntries(kind)) kinds.set(entry.name, kind)
  }
  const plain = new Map<string, Fields>()
  const opened: Record<string, Record<string, string>> = {}
  for (const ref of refs) {
    const kind = kinds.get(ref)
    if (kind === undefined) {
      throw new ResourceError('invalid', `${ref} is not saved as a VFS, CLI, runtime or machine`)
    }
    const entry = await store.revealEntry(kind, ref)
    plain.set(ref, entry.fields)
    const every = { ...entry.fields, ...entry.sealed }
    opened[ref] = Object.fromEntries(Object.entries(every).map(([k, v]) => [k, flat(v)]))
  }
  let cfg: WorkspaceConfigRaw
  try {
    cfg = checkConfig(inline(written, plain))
  } catch (e) {
    throw new ResourceError('invalid', (e as Error).message)
  }
  return {
    ...cfg,
    secrets: {
      ...(cfg.secrets ?? {}),
      [STRUKTO]: { source: STRUKTO, config: { entries: opened } },
    },
  }
}
