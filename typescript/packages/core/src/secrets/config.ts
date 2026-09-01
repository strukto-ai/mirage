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

import { z } from 'zod'

// The sources a source's own config may read from: those that take no
// config themselves, so the table bottoms out instead of needing a
// dependency graph. Everything else declares its credentials here and
// is reached through this block. Kept sorted: it is rendered into the
// refusal, which Python renders from a set it sorts.
export const BOOTSTRAP_SOURCES: readonly string[] = ['dotenv', 'env']

/**
 * One entry of the env map: a literal value or a managed pointer.
 *
 * The env block is one map, name -> entry. A bare string in the map is
 * the literal short form and never reaches this schema; a mapping is
 * validated through it. `value` and `from` are mutually exclusive and
 * one is required: `readonly`/`export` belong to a literal entry,
 * `ref`/`key`/`fetch` to a managed one. The wire key is `from:` in both
 * languages; Python exposes it as `provider` in code only because
 * `from` is a keyword there.
 */
export const EnvVarSchema = z
  .strictObject({
    value: z.string().optional(),
    readonly: z.boolean().default(false),
    export: z.boolean().default(true),
    from: z.string().optional(),
    ref: z.string().default(''),
    key: z.string().optional(),
    fetch: z.enum(['lazy', 'eager']).default('lazy'),
  })
  .superRefine((entry, ctx) => {
    if (entry.value !== undefined && entry.from !== undefined) {
      ctx.addIssue({ code: 'custom', message: "an env entry takes 'value' or 'from', not both" })
      return
    }
    if (entry.value === undefined && entry.from === undefined) {
      ctx.addIssue({ code: 'custom', message: "an env entry needs 'value' or 'from'" })
      return
    }
    if (entry.from !== undefined) {
      if (entry.readonly) {
        ctx.addIssue({
          code: 'custom',
          message:
            "'readonly' is for literal entries; a readonly managed variable " +
            'would change under refresh',
        })
      }
      if (!entry.export) {
        ctx.addIssue({
          code: 'custom',
          message: "'export' is for literal entries; a managed variable is always exported",
        })
      }
    } else if (entry.ref !== '' || entry.key !== undefined || entry.fetch !== 'lazy') {
      ctx.addIssue({
        code: 'custom',
        message: "'ref', 'key' and 'fetch' are for managed entries ('from')",
      })
    }
  })

export type EnvVar = z.infer<typeof EnvVarSchema>

/** The env block as an embedder or the config door writes it. */
export type EnvEntries = Record<string, string | z.input<typeof EnvVarSchema>>

/**
 * A source-config value read from a bootstrap source.
 *
 * The config plane's pointer, spelled with the same three keys the env
 * plane's managed entry uses, so one grammar covers both. Only a
 * bootstrap source may back one: those take no config of their own,
 * which is what stops the table from needing a dependency graph.
 */
export const SecretRefSchema = z.strictObject({
  from: z.string().refine((name) => BOOTSTRAP_SOURCES.includes(name), {
    message:
      `a source config reads from ${BOOTSTRAP_SOURCES.join(', ')}, ` +
      'not that source; only a source that needs no config of its own can ' +
      'bootstrap another',
  }),
  ref: z.string().default(''),
  key: z.string(),
})

export type SecretRef = z.infer<typeof SecretRefSchema>

/**
 * One declared source instance: which source, and its config.
 *
 * The `secrets:` block is one map, instance name -> block, spelled the
 * way `mounts:` and `clis:` are: a type beside a config. The instance
 * name is what a managed env entry's `from:` names, so two accounts of
 * one platform are two instances, and an instance named after its
 * source reads as that source configured.
 *
 * The config map is untyped here, the way `mounts.*.config` is: each
 * source owns its own model, and this block only has to tell a pointer
 * from a literal. It does that the way the env plane does, by the
 * presence of `from`, so a mapping carrying one is validated as a
 * `SecretRef` and every other value passes through to the source's
 * model.
 */
export const SourceBlockSchema = z.strictObject({
  source: z.string(),
  // A custom check rather than `z.record`, which builds its output by
  // keyed assignment and so DROPS a `__proto__` key outright -- the
  // deployment's own spelling would vanish instead of reaching the
  // source's model, where python reports it as an unknown field.
  config: z
    .custom<Record<string, unknown>>(
      (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
      { message: 'config must be a mapping' },
    )
    .default({})
    .transform((config, ctx) => {
      const out: [string, unknown][] = []
      for (const [name, item] of Object.entries(config)) {
        const pointer =
          typeof item === 'object' && item !== null && !Array.isArray(item) && 'from' in item
        if (!pointer) {
          out.push([name, item])
          continue
        }
        // Reported, never thrown: a throw from inside a transform
        // escapes safeParse, and the config door's own wrapper (which
        // names the instance) would never see the failure.
        const parsed = SecretRefSchema.safeParse(item)
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            ctx.addIssue({ code: 'custom', message: issue.message, path: [name, ...issue.path] })
          }
          continue
        }
        out.push([name, parsed.data])
      }
      // Object.fromEntries, not keyed assignment: a config key named
      // `__proto__` would otherwise assign through the prototype
      // setter and never reach the source's own model, where python's
      // dict passes it through like any other.
      return Object.fromEntries(out)
    }),
})

export type SourceBlock = z.infer<typeof SourceBlockSchema>

/** The `secrets:` block as an embedder or the config door writes it. */
export type SourceEntries = Record<string, z.input<typeof SourceBlockSchema>>
