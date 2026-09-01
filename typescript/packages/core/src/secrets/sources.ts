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

import type { z } from 'zod'

import type { SecretRef, SourceBlock } from './config.ts'
import { SecretsError } from './errors.ts'
import { fieldSummary } from './summary.ts'
import { fetchSecret, sourceFor } from './registry.ts'
import type { ResolvedSecret, ResolvedSource } from './types.ts'

/**
 * Whether one config value is a pointer rather than a literal.
 *
 * The same rule the block's own schema applies, restated for a value
 * that reached us already parsed: a mapping carrying `from` is a
 * pointer, everything else belongs to the source's own model.
 */
function isSecretRef(value: unknown): value is SecretRef {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'from' in value
}

/**
 * Read one source-config value from its bootstrap source.
 *
 * Throws SecretsError naming the instance, the field and the source,
 * and nothing else, whether the fetch failed or the field is absent.
 * That is the boundary `fillEnv` draws and it is drawn for the same
 * reason: a dotenv miss renders the host path it looked for, and a
 * custom source shadowing `env` renders whatever it likes. The
 * source's own words go to the host log instead.
 */
export async function configValue(
  name: string,
  field: string,
  ref: SecretRef,
  fetched: Map<string, ResolvedSecret>,
): Promise<string> {
  const cacheKey = `${ref.from}\u0000${ref.ref}`
  const seen = fetched.get(cacheKey)
  if (seen !== undefined) return selectField(name, field, ref, seen)
  let secret
  try {
    secret = await fetchSecret(ref.from, ref.ref)
  } catch (caught) {
    console.warn(
      `secrets.${name}.config.${field}: fetch from ${ref.from} failed: ${String(caught)}`,
    )
    throw new SecretsError(`secrets.${name}.config.${field}: cannot fetch from ${ref.from}`, {
      cause: caught,
    })
  }
  fetched.set(cacheKey, secret)
  return selectField(name, field, ref, secret)
}

function selectField(name: string, field: string, ref: SecretRef, secret: ResolvedSecret): string {
  // Own properties only, the check `fillEnv` already makes: a plain
  // object answers `fields['constructor']` with a prototype member,
  // and that would reach the source's config model as a value.
  const value = Object.hasOwn(secret.fields, ref.key) ? secret.fields[ref.key] : undefined
  if (value === undefined) {
    throw new SecretsError(
      `secrets.${name}.config.${field}: wanted field '${ref.key}', ` +
        `the ${ref.from} secret has ${fieldSummary(secret.fields, ref.from)}`,
    )
  }
  return value
}

// The field path and the error code, never the rendered message: a
// custom source's own refinement may spell the rejected input, and the
// values are where a fetched credential has just landed. An
// unrecognized key carries no path, so its own names stand in -- they
// are what the deployment wrote in the block, not anything fetched.
function issueDetail(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String).join('.')
  const where = path !== '' ? path : issue.code === 'unrecognized_keys' ? issue.keys.join(', ') : ''
  return `${where}: ${issue.code}`
}

/**
 * Build every declared instance, reading its pointers.
 *
 * Runs once per workspace, before the first fetch, and reaches only
 * bootstrap sources -- the process env and dotenv files -- so a
 * declaration this cannot satisfy is a config error and rightly fails
 * every line, while a source that is merely unreachable still fails
 * only the names that want it.
 *
 * Throws SecretsError for an unknown source, a missing bootstrap
 * field, or config the source's own model refuses. A refusal is
 * reported by field and reason only; the values are never in the
 * message.
 */
export async function resolveSources(
  blocks: Readonly<Record<string, SourceBlock>>,
): Promise<Record<string, ResolvedSource>> {
  const out: [string, ResolvedSource][] = []
  // One fetch per bootstrap secret for the whole resolution: two
  // fields of one config naming the same dotenv file must read one
  // generation of it, or a rotation between them pins a mismatched
  // pair for the workspace's life.
  const fetched = new Map<string, ResolvedSecret>()
  for (const [name, block] of Object.entries(blocks)) {
    const { configModel, fetch } = sourceFor(block.source)
    // fromEntries, not keyed assignment: the block's schema now keeps
    // a `__proto__` config key, and this is where it would be lost on
    // the way to the source's own model.
    const pairs: [string, unknown][] = []
    for (const [field, value] of Object.entries(block.config)) {
      pairs.push([
        field,
        isSecretRef(value) ? await configValue(name, field, value, fetched) : value,
      ])
    }
    const values = Object.fromEntries(pairs)
    let parsed
    try {
      parsed = configModel.safeParse(values)
    } catch (caught) {
      // A refinement that THROWS never becomes an issue list, and
      // safeParse does not catch it. The words are the refinement's,
      // over a value just fetched.
      console.warn(`secrets.${name}: config validation threw: ${String(caught)}`)
      throw new SecretsError(`secrets.${name}: config refused`, { cause: caught })
    }
    if (!parsed.success) {
      console.warn(`secrets.${name}: config refused: ${parsed.error.message}`)
      // The issue CODE, never zod's rendered message: a custom
      // source's own refinement may spell the rejected input, and
      // `values` is where a fetched credential has just landed. The
      // field path and the code say what is wrong; the words go to the
      // host log.
      const detail = parsed.error.issues.map(issueDetail).join('; ')
      throw new SecretsError(`secrets.${name}: ${detail}`)
    }
    out.push([name, { source: block.source, config: parsed.data, fetch }])
  }
  // Object.fromEntries, not a keyed object literal: an instance named
  // `__proto__` assigns through the prototype setter and leaves no own
  // entry for the lookup to find, where python's dict takes the name
  // like any other.
  return Object.fromEntries(out)
}
