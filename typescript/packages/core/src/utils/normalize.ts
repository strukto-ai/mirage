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

export interface FieldNormalizer {
  /** Explicit `python_snake_case` → `tsCamelCase` overrides. */
  rename?: Record<string, string>
  /** Source keys to drop silently (e.g. unsupported fields). */
  drop?: readonly string[]
}

export function snakeToCamel(snake: string): string {
  return snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

/** The key `normalizeFields` writes an input key's value under. */
export function normalizedKey(key: string, spec: FieldNormalizer = {}): string {
  return spec.rename?.[key] ?? snakeToCamel(key)
}

/**
 * Translate a Python-style snake_case config blob to a TS camelCase one.
 *
 * Lookup order for each input key:
 *   1. `drop` — silently skipped.
 *   2. `rename` — used as the output key.
 *   3. Default — `snakeToCamel(key)`. Already-camelCase keys round-trip unchanged.
 */
export function normalizeFields(
  input: Record<string, unknown>,
  spec: FieldNormalizer = {},
): Record<string, unknown> {
  const drop = new Set(spec.drop ?? [])
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (drop.has(key)) continue
    out[normalizedKey(key, spec)] = value
  }
  return out
}
