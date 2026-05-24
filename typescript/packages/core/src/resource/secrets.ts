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

import { z, type ZodObject, type ZodRawShape } from 'zod'

export const REDACTED_SECRET = '<REDACTED>' as const

const SECRET_META_KEY = 'mirageSecret'

type SchemaType = z.core.SomeType
type ShapeRecord = Record<string, SchemaType>
interface SchemaDef {
  innerType?: SchemaType
}

export type SecretStr = string & { readonly __mirageSecret: unique symbol }

export function secretStr(): z.ZodString {
  return secretSchema(z.string())
}

export function secretSchema<T extends z.ZodType>(schema: T): T {
  return schema.meta({ [SECRET_META_KEY]: true })
}

export function redactConfigWithSchema<T extends ZodRawShape>(
  schema: ZodObject<T>,
  config: unknown,
): Record<string, unknown> {
  return redactValueWithSchema(schema, schema.parse(config)) as Record<string, unknown>
}

export function hasRedactedSecret(value: unknown): boolean {
  if (value === REDACTED_SECRET) return true
  if (Array.isArray(value)) return value.some((v) => hasRedactedSecret(v))
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) => hasRedactedSecret(v))
  }
  return false
}

export function resourceStateRequiresOverride(state: unknown): boolean {
  if (!isRecord(state)) return false
  return hasRedactedSecret(state.config)
}

function redactValueWithSchema(schema: SchemaType, value: unknown): unknown {
  if (value === undefined || value === null) return value
  if (isSecretSchema(schema)) return REDACTED_SECRET

  const unwrapped = unwrapSchema(schema)
  if (unwrapped instanceof z.ZodObject && isRecord(value)) {
    return redactObjectWithSchema(unwrapped, value)
  }
  if (unwrapped instanceof z.ZodArray && Array.isArray(value)) {
    return value.map((item) => redactValueWithSchema(unwrapped.element, item))
  }
  return value
}

function redactObjectWithSchema(
  schema: ZodObject<ZodRawShape>,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...value }
  const shape = schema.shape as ShapeRecord
  for (const [key, childSchema] of Object.entries(shape)) {
    if (!(key in out)) continue
    out[key] = redactValueWithSchema(childSchema, out[key])
  }
  return out
}

function isSecretSchema(schema: SchemaType): boolean {
  return schemaMeta(unwrapSchema(schema))?.[SECRET_META_KEY] === true
}

function unwrapSchema(schema: SchemaType): SchemaType {
  let current = schema
  for (;;) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap()
      continue
    }
    const def = schemaDef(current)
    if (def.innerType !== undefined) {
      current = def.innerType
      continue
    }
    return current
  }
}

function schemaMeta(schema: SchemaType): Record<string, unknown> | undefined {
  const maybeMeta = (schema as { meta?: () => Record<string, unknown> | undefined }).meta
  return maybeMeta?.()
}

function schemaDef(schema: SchemaType): SchemaDef {
  const candidate = schema as {
    def?: SchemaDef
    _zod?: { def?: SchemaDef }
  }
  return candidate.def ?? candidate._zod?.def ?? {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
