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
import { type FieldNormalizer, normalizeFields } from '../utils/normalize.ts'

// Re-exported so a config schema in the browser or node package is built
// with the zod core resolves, not with a second copy of its own. The
// helpers below are typed against this instance, and two installs make
// every ZodObject here structurally unrelated to the one over there --
// it still type-checks, but it takes minutes per config file.
export { z }

export const REDACTED_SECRET = '<REDACTED>' as const

const SECRET_META_KEY = 'mirageSecret'

type SchemaType = z.core.SomeType
type ShapeRecord = Record<string, SchemaType>
interface SchemaDef {
  innerType?: SchemaType
}

// A config's shape, read off the schema that already validates it rather
// than declared a second time by hand. `z.infer` alone is not a drop-in:
// it renders an optional field as `k?: T | undefined`, which under
// `exactOptionalPropertyTypes` is wider than the `k?: T` these configs
// were written with and stops a subclass's state from matching its base's.
// The mapping is homomorphic, so `?` survives and only the explicit
// `undefined` goes.
export type ConfigOf<S extends z.ZodType> = {
  [K in keyof z.infer<S>]: Exclude<z.infer<S>[K], undefined>
}

// The redacted twin of a config, naming only the secret fields. The
// `secretStr`/`secretSchema` marker is runtime metadata on a plain
// `z.ZodString`, so no type can read it back off the schema and the secret
// list has to be written down once; what this removes is the other half of
// the twin, which used to re-list every ordinary field by hand and drifted
// the moment one was added. The mapping goes through `Pick` so it is
// homomorphic and an optional secret stays optional: a bare `[P in K]` is
// not, and made every optional secret required.
//
// A nullable secret keeps null in the redacted twin, because an absent
// credential is not a masked one: `redactValueWithSchema` returns null
// before it ever asks whether the field is secret, mirroring Python's
// `if value is None: continue` in `_walk_config_dump`. Masking it would
// plant a `<REDACTED>` marker that makes `Workspace.load` demand a fresh
// config for a snapshot that never held a credential.
export type RedactedConfig<T, K extends keyof T> = Omit<T, K> & {
  [P in keyof Pick<T, K>]: null extends T[P]
    ? typeof REDACTED_SECRET | null
    : typeof REDACTED_SECRET
}

export function secretStr(): z.ZodString {
  return secretSchema(z.string())
}

export function secretSchema<T extends z.ZodType>(schema: T): T {
  return schema.meta({ [SECRET_META_KEY]: true })
}

/**
 * The one door a mount config comes through: rename the python-side
 * spellings, then validate.
 *
 * Every `normalize*Config` is this call with its schema, so a config that
 * reaches a resource has been checked the way pydantic checks the python
 * twin on construction. It used to be `normalizeFields` alone in 56 of 60
 * normalizers, which let `bucket: 123`, `timeout: "abc"` and a Google
 * config naming no credential at all reach their clients unrefused, and
 * left every requiredness rule in these schemas unreachable from the mount
 * path -- `GitHubConfigSchema` required `owner` and nothing ever asked it.
 *
 * Unknown keys are stripped, not refused, because pydantic's default
 * `extra="ignore"` does the same on the python side; the CLI registry adds
 * its own fail-loud check on top for both languages. A callable a config
 * carries (a token provider, a refresh hook) must be declared in the schema
 * through `secretSchema(z.custom(...))` or parse strips it -- that is also
 * what keeps it out of snapshot state.
 */
export function parseConfigWithSchema<T extends ZodRawShape>(
  schema: ZodObject<T>,
  input: Record<string, unknown>,
  normalizer: FieldNormalizer = {},
): ConfigOf<ZodObject<T>> {
  return schema.parse(normalizeFields(input, normalizer)) as ConfigOf<ZodObject<T>>
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

/**
 * Whether restoring this mount needs a live resource handed in.
 *
 * A redaction marker says the saved config is missing a credential. The
 * explicit `needs_override` says the mount cannot be rebuilt from its
 * state at all — which in TypeScript is true of every config-backed
 * backend, because `buildMountArgs` substitutes a `RAMResource` for any
 * mount it was not given (`snapshot/state.ts`). Python instead
 * reconstructs the class from `resource_state["type"]` via its registry
 * (`_resource_class_for`), so the field is inert there and only four of
 * its resources bother to write it; TypeScript has to read it or a live
 * database mount comes back as an empty directory.
 *
 * The lasting fix is to give `buildMountArgs` a resource factory, which
 * core cannot import today (`buildResource` lives in node/browser).
 */
export function resourceStateRequiresOverride(state: unknown): boolean {
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
