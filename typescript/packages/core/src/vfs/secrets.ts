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
import { type FieldNormalizer, normalizedKey, normalizeFields } from '../utils/normalize.ts'
import { isRecord } from '../utils/records.ts'
import { REDACTED_SECRET } from './constants.ts'

// Re-exported so a config schema in the browser or node package is built
// with the zod core resolves, not with a second copy of its own. The
// helpers below are typed against this instance, and two installs make
// every ZodObject here structurally unrelated to the one over there --
// it still type-checks, but it takes minutes per config file.
export { z }

const SECRET_META_KEY = 'mirageSecret'

export function secretStr(): SecretSchema<z.ZodString> {
  return secretSchema(z.string())
}

export function secretSchema<T extends z.ZodType>(schema: T): SecretSchema<T> {
  return schema.meta({ [SECRET_META_KEY]: true }) as SecretSchema<T>
}

/**
 * The python spellings a config schema takes, registered beside the schema
 * (`z.object({...}).register(FIELD_NORMALIZERS, { rename: {...} })`) the way
 * a pydantic field carries its alias, so every caller of
 * {@link parseConfigWithSchema} renames the same keys.
 */
export const FIELD_NORMALIZERS = z.registry<FieldNormalizer>()

/**
 * The one loader a mount config comes through: rename the python-side
 * spellings, then validate.
 *
 * Every registry entry calls this with its backend's schema, so a config
 * that reaches a VFS has been checked the way pydantic checks the python
 * twin on construction. It used to be `normalizeFields` alone in 56 of 60
 * normalizers, which let `bucket: 123`, `timeout: "abc"` and a Google
 * config naming no credential at all reach their clients unrefused, and
 * left every requiredness rule in these schemas unreachable from the mount
 * path -- `GitHubConfigSchema` required `owner` and nothing ever asked it.
 * The renames come from the schema's {@link FIELD_NORMALIZERS} entry.
 *
 * Unknown keys are refused, as every python config refuses them with
 * `extra="forbid"`: they used to be stripped, so a typo'd `team_idz` built
 * a mount that exposed every team, with no error on either side. The check
 * runs on the input before the renames, so a snake_case spelling of a
 * declared field is known and an unknown key is named as the block wrote
 * it. A callable a config carries (a token provider, a refresh hook) must
 * be declared in the schema through `secretSchema(z.custom(...))` or it is
 * an unknown key too -- the declaration is also what keeps it out of
 * snapshot state.
 */
export function parseConfigWithSchema<T extends ZodRawShape>(
  schema: ZodObject<T>,
  input: Record<string, unknown>,
): ConfigOf<ZodObject<T>> {
  const normalizer = FIELD_NORMALIZERS.get(schema) ?? {}
  if (refusesExtraKeys(schema)) refuseUnknownKeys(input, Object.keys(schema.shape), normalizer)
  return schema.parse(normalizeFields(input, normalizer)) as ConfigOf<ZodObject<T>>
}

/**
 * Refuse the keys of a config block that no field takes.
 *
 * Each key is looked up under the name the normalizer writes it to, and an
 * unknown one is reported in the block's own spelling, one
 * `unrecognized_keys` issue per key: the summary then reads
 * `<vfs>: team_idz: unrecognized_keys` where python's reads
 * `<vfs>: team_idz: extra_forbidden`, the same field named the same way.
 * Exported for the backends that take their options without a schema
 * (`ram`, `disk`, `redis`, `opfs`), which python builds from constructor
 * keywords and refuses the same way.
 */
export function refuseUnknownKeys(
  input: Record<string, unknown>,
  fields: Iterable<string>,
  normalizer: FieldNormalizer = {},
): void {
  const known = new Set(fields)
  const drop = new Set(normalizer.drop ?? [])
  const unknown = Object.keys(input).filter(
    (key) => !drop.has(key) && !known.has(normalizedKey(key, normalizer)),
  )
  if (unknown.length === 0) return
  throw new z.ZodError(
    unknown.map((key) => ({
      code: 'unrecognized_keys' as const,
      keys: [key],
      path: [],
      message: `Unrecognized key: ${JSON.stringify(key)}`,
    })),
  )
}

/**
 * Refuse a config block that names one field under two spellings.
 *
 * `normalizeFields` writes `key_prefix` and `keyPrefix` to the same key,
 * so without this the later one would win by object order. Python's
 * models take only the snake_case spelling and refuse the camelCase one
 * as an extra field, so each clash is reported the way
 * `refuseUnknownKeys` reports a key: an `unrecognized_keys` issue naming
 * the camelCase spelling, whose summary then reads as python's
 * `keyPrefix: extra_forbidden` does.
 */
export function refuseRepeatedFields(input: Record<string, unknown>): void {
  const seen = new Map<string, string>()
  const issues: z.core.$ZodIssue[] = []
  for (const key of Object.keys(input)) {
    const field = normalizedKey(key)
    const first = seen.get(field)
    if (first === undefined) {
      seen.set(field, key)
      continue
    }
    issues.push({
      code: 'unrecognized_keys',
      keys: [field],
      path: [],
      message: `${JSON.stringify(first)} and ${JSON.stringify(key)} name the same field`,
    })
  }
  if (issues.length > 0) throw new z.ZodError(issues)
}

/** A string field trimmed, refused when nothing is left. */
export function normalizeNonEmpty(value: string, field: string): string {
  const normalized = value.trim()
  if (normalized === '') {
    throw new Error(`${field} cannot be empty`)
  }
  return normalized
}

// A schema that declares its own policy for extra keys keeps it: a loose
// one passes them through the way pydantic's `extra="allow"` does. A strict
// one refuses them in parse as well, but after the renames, so zod would
// name the camelCase spelling; it is checked up front like the default.
function refusesExtraKeys(schema: ZodObject<ZodRawShape>): boolean {
  const catchall = schema.def.catchall
  return catchall === undefined || catchall instanceof z.ZodNever
}

export function redactConfigWithSchema<S extends ZodObject>(
  schema: S,
  config: unknown,
): RedactedSchema<S> {
  return redactValueWithSchema(schema, schema.parse(config)) as RedactedSchema<S>
}

export function hasRedactedSecret(value: unknown): boolean {
  if (value === REDACTED_SECRET) return true
  if (Array.isArray(value)) return value.some((v) => hasRedactedSecret(v))
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) => hasRedactedSecret(v))
  }
  return false
}

/**
 * Whether restoring this mount needs a live VFS handed in.
 *
 * A redaction marker says the saved config is missing a credential. The
 * explicit `needs_override` says the mount cannot be rebuilt from its
 * state at all — which in TypeScript is true of every config-backed
 * backend, because `buildMountArgs` substitutes a `RAMVFS` for any
 * mount it was not given (`snapshot/state.ts`). Python instead
 * reconstructs the class from `vfs_state["type"]` via its registry
 * (`_vfs_class_for`), so the field is inert there and only four of
 * its VFS classes bother to write it; TypeScript has to read it or a live
 * database mount comes back as an empty directory.
 *
 * The lasting fix is to give `buildMountArgs` a VFS factory, which
 * core cannot import today (`buildVfs` lives in node/browser).
 */
export function vfsStateRequiresOverride(state: unknown): boolean {
  if (!isRecord(state)) return false
  if (state.needs_override === true) return true
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
  const shape = schema.shape as Record<string, SchemaType>
  for (const [key, childSchema] of Object.entries(shape)) {
    if (!(key in out)) continue
    out[key] = redactValueWithSchema(childSchema, out[key])
  }
  return out
}

// A record of secrets is one secret field, as Python's dict[str, SecretStr] is.
function isSecretSchema(schema: SchemaType): boolean {
  const unwrapped = unwrapSchema(schema)
  if (schemaMeta(unwrapped)?.[SECRET_META_KEY] === true) return true
  return unwrapped instanceof z.ZodRecord && isSecretSchema(unwrapped.valueType as SchemaType)
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

declare const SECRET_SCHEMA: unique symbol

/** A schema whose value is secret; this marker changes no input type. */
export type SecretSchema<S extends z.ZodType> = S & { readonly [SECRET_SCHEMA]: true }

type Unwrapped<S extends z.ZodType> =
  S extends SecretSchema<z.ZodType>
    ? S
    : S extends
          | z.ZodOptional<infer I>
          | z.ZodNullable<infer I>
          | z.ZodDefault<infer I>
          | z.ZodPrefault<infer I>
          | z.ZodNonOptional<infer I>
          | z.ZodReadonly<infer I>
      ? I extends z.ZodType
        ? Unwrapped<I>
        : S
      : S

type SecretValue<S extends z.ZodType> =
  Unwrapped<S> extends SecretSchema<z.ZodType>
    ? true
    : Unwrapped<S> extends z.ZodRecord<z.core.$ZodRecordKey, infer V>
      ? V extends z.ZodType
        ? SecretValue<V>
        : false
      : false

type RedactedValue<S extends z.ZodType, T> =
  SecretValue<S> extends true
    ? typeof REDACTED_SECRET | Extract<T, null | undefined>
    : Unwrapped<S> extends z.ZodObject<infer Shape>
      ? RedactedFields<T, Shape>
      : Unwrapped<S> extends z.ZodArray<infer Item>
        ? Item extends z.ZodType
          ? T extends (infer V)[]
            ? RedactedValue<Item, V>[]
            : T extends readonly (infer V)[]
              ? readonly RedactedValue<Item, V>[]
              : T
          : T
        : T

type RedactedFields<T, Shape extends z.ZodRawShape> = {
  [K in keyof T]: Exclude<
    K extends keyof Shape
      ? Shape[K] extends z.ZodType
        ? RedactedValue<Shape[K], T[K]>
        : T[K]
      : T[K],
    undefined
  >
}

/** Snapshot fields inferred from the same schema that redacts them at runtime. */
export type RedactedSchema<S extends z.ZodObject, C = ConfigOf<S>> = RedactedFields<C, S['shape']>

/** Schema output with absent optional fields, matching exactOptionalPropertyTypes. */
export type ConfigOf<S extends z.ZodType> = {
  [K in keyof z.infer<S>]: Exclude<z.infer<S>[K], undefined>
}

export type SchemaType = z.core.SomeType

export interface SchemaDef {
  innerType?: SchemaType
}
