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

type ValueTransform = (value: unknown) => unknown

export interface FieldNormalizer {
  /** Explicit `python_snake_case` → `tsCamelCase` overrides. */
  rename?: Record<string, string>
  /** Optional per-source-key value transforms (run before rename). */
  transform?: Record<string, ValueTransform>
  /** Source keys to drop silently (e.g. unsupported fields). */
  drop?: readonly string[]
}

/**
 * Python states a timeout in seconds where TypeScript uses milliseconds, so
 * the S3 family and the Hub configs rename `timeout` to `timeoutMs` and
 * convert through this. A non-number passes untouched for the schema to
 * refuse, rather than being multiplied into a different wrong number.
 */
export function secondsToMs(value: unknown): unknown {
  return typeof value === 'number' ? value * 1000 : value
}

export function snakeToCamel(snake: string): string {
  return snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

/**
 * Translate a Python-style snake_case config blob to a TS camelCase one.
 *
 * Lookup order for each input key:
 *   1. `drop` — silently skipped.
 *   2. `rename` — used as the output key.
 *   3. Default — `snakeToCamel(key)`. Already-camelCase keys round-trip unchanged.
 *
 * Values pass through untouched unless `transform[key]` is set.
 */
export function normalizeFields(
  input: Record<string, unknown>,
  spec: FieldNormalizer = {},
): Record<string, unknown> {
  const drop = new Set(spec.drop ?? [])
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (drop.has(key)) continue
    const renamed = spec.rename?.[key] ?? snakeToCamel(key)
    const transformer = spec.transform?.[key]
    out[renamed] = transformer !== undefined ? transformer(value) : value
  }
  return out
}
