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

import { cliSpecFor, knownCliNames } from '@struktoai/mirage-core/commands/cli/specs'
import { NAME as MCP_CLI } from '@struktoai/mirage-core/commands/cli/mcp/constants'
import { MCPConfig } from '@struktoai/mirage-core/core/mcp/config'
import { knownProviders, machineClass } from '@struktoai/mirage-core/machine/registry'
import type { EntryKind } from '@struktoai/mirage-core/resources/types'
import type { ConfigFields } from '@struktoai/mirage-core/runtime/config'
import { SECRET_CONFIG_FIELDS } from '@struktoai/mirage-core/runtime/constants'
import {
  HOST,
  IN_PROCESS,
  inProcessRuntimes,
  knownRuntimes,
  runtimeClass,
  WORKER,
} from '@struktoai/mirage-core/runtime/table'
import { normalizedKey } from '@struktoai/mirage-core/utils/normalize'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import { FIELD_NORMALIZERS, z } from '@struktoai/mirage-core/vfs/secrets'
import type { ServerHost } from '../routes.ts'
import type { Field, FieldType, TypeTable } from './types.ts'

type Schema = z.ZodType

function def(s: Schema): Record<string, unknown> {
  return (
    (s as unknown as { def?: Record<string, unknown> }).def ??
    (s as unknown as { _zod?: { def?: Record<string, unknown> } })._zod?.def ??
    {}
  )
}

/** The schema under its optional, nullable and default wrappers, and the default they give. */
function unwrap(s: Schema): { inner: Schema; fallback: unknown } {
  let fallback: unknown
  let at = s
  for (;;) {
    if (at instanceof z.ZodOptional || at instanceof z.ZodNullable) {
      at = at.unwrap() as Schema
      continue
    }
    if (at instanceof z.ZodDefault) {
      const d = def(at).defaultValue
      fallback = typeof d === 'function' ? (d as () => unknown)() : d
    }
    const pipe = def(at)
    if (pipe.type === 'pipe' && pipe.out !== undefined) {
      at = pipe.out as Schema
      continue
    }
    const inner = def(at).innerType as Schema | undefined
    if (inner === undefined) return { inner: at, fallback }
    at = inner
  }
}

function meta(s: Schema): Record<string, unknown> {
  return s.meta() ?? {}
}

/** `baseUrl` as a config writes it: `base_url`, or the schema's own rename. */
function configName(camel: string, schema: Schema): string {
  const rename: Record<string, string> = FIELD_NORMALIZERS.get(schema)?.rename ?? {}
  const renamed = Object.entries(rename).find(([, to]) => to === camel)?.[0]
  const snake = renamed ?? camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
  return normalizedKey(snake, { rename }) === camel ? snake : camel
}

/** The field type a config writes for a schema, with its options, or null for one it cannot write. */
function kindOf(inner: Schema): { type: FieldType; options?: string[] } | null {
  if (inner instanceof z.ZodString) return { type: 'string' }
  if (inner instanceof z.ZodNumber) return { type: 'number' }
  if (inner instanceof z.ZodBoolean) return { type: 'boolean' }
  if (inner instanceof z.ZodEnum) {
    return { type: 'string', options: (inner.options as unknown[]).map(String) }
  }
  if (inner instanceof z.ZodLiteral) {
    const values = [...(def(inner).values as unknown[])]
    return {
      type: values.every((v) => typeof v === 'number') ? 'number' : 'string',
      options: values.map(String),
    }
  }
  if (inner instanceof z.ZodArray && unwrap(inner.element as Schema).inner instanceof z.ZodString) {
    return { type: 'list' }
  }
  if (
    inner instanceof z.ZodUnion &&
    (def(inner).options as Schema[]).some((o) => unwrap(o).inner instanceof z.ZodString)
  ) {
    return { type: 'string' }
  }
  return null
}

/**
 * A config schema's fields as a config writes them: python spellings, a
 * nested block's fields as `block.field` in its `group`, and only the
 * fields a config can hold. Mirrors Python's `model_fields`.
 */
function modelFields(schema: Schema, group?: string): Field[] {
  const object = unwrap(schema).inner
  if (!(object instanceof z.ZodObject)) return []
  const out: Field[] = []
  for (const [camel, raw] of Object.entries(object.shape as Record<string, Schema>)) {
    const { inner, fallback } = unwrap(raw)
    const name = configName(camel, object)
    if (inner instanceof z.ZodObject) {
      for (const f of modelFields(inner, name)) out.push({ ...f, name: `${name}.${f.name}` })
      continue
    }
    const kind = kindOf(inner)
    if (kind === null) continue
    const description = raw.description ?? inner.description ?? meta(inner).description
    const given = meta(raw).default ?? meta(inner).default ?? fallback
    out.push({
      name,
      type: kind.type,
      secret: meta(inner).mirageSecret === true,
      required: !raw.safeParse(undefined).success,
      ...(kind.options !== undefined ? { options: kind.options } : {}),
      ...(typeof description === 'string' && description !== '' ? { description } : {}),
      ...(['string', 'number', 'boolean'].includes(typeof given)
        ? { default: given as string | number | boolean }
        : {}),
      ...(group !== undefined ? { group } : {}),
    })
  }
  return out
}

/** Every VFS the host builds from a config schema, with its fields. */
async function vfsTypes(schemas: ServerHost['vfsSchemas']): Promise<TypeTable> {
  const out: TypeTable = {}
  for (const name of Object.keys(schemas).sort(compareCodePoints)) {
    const load = schemas[name]
    if (load !== undefined) out[name] = modelFields(await load())
  }
  return out
}

/** Every registered CLI that takes a config, and `mcp`, with its fields. */
function cliTypes(): TypeTable {
  const out: TypeTable = { [MCP_CLI]: modelFields(MCPConfig) }
  for (const name of knownCliNames()) {
    const model = cliSpecFor(name).configModel
    if (model instanceof z.ZodObject) out[name] = modelFields(model)
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => compareCodePoints(a, b)))
}

/** The fields a config takes, a map field left out as a form cannot write one. */
function configTypes(configFields: ConfigFields): Field[] {
  const fields: Field[] = []
  for (const [camel, field] of Object.entries(configFields)) {
    if (field.type === 'map') continue
    const snake = camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
    fields.push({
      name: snake,
      type: field.type,
      secret: SECRET_CONFIG_FIELDS.has(snake),
      required: field.required ?? false,
      ...(field.options !== undefined ? { options: [...field.options] } : {}),
      ...(field.default !== undefined ? { default: field.default } : {}),
    })
  }
  return fields
}

/**
 * Every machine provider and engine provider, with its fields: a worker
 * where monty runs on one, a host where this host registers its own
 * programs.
 */
function machineTypes(): TypeTable {
  const captures: Field = { name: 'captures', type: 'list', secret: false, required: false }
  const inProcess = inProcessRuntimes()
  const out: TypeTable = {
    [IN_PROCESS]: [
      { name: 'runtime', type: 'string', secret: false, required: true, options: inProcess },
      captures,
    ],
  }
  if (!inProcess.includes('monty'))
    out[WORKER] = [...configTypes(runtimeClass('monty').configFields), captures]
  if (knownRuntimes().includes('local'))
    out[HOST] = [...configTypes(runtimeClass('local').configFields), captures]
  for (const provider of knownProviders())
    out[provider] = configTypes(machineClass(provider).configFields)
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => compareCodePoints(a, b)))
}

/**
 * The types an entry of `kind` can be, each with its fields, read off
 * mirage's registries and config schemas; a VFS's off the schemas of the
 * ones `host` builds.
 */
export async function typesOf(
  kind: EntryKind,
  host: Pick<ServerHost, 'vfsSchemas'>,
): Promise<TypeTable> {
  if (kind === 'vfs') return vfsTypes(host.vfsSchemas)
  if (kind === 'cli') return cliTypes()
  if (kind === 'machine') return machineTypes()
  throw new Error(`${kind} entries have no types`)
}
