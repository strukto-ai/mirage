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

/**
 * How a runtime's engine is set up: its implementation knobs.
 *
 * Every runtime is constructed the same way (captures, config,
 * script); what differs between runtimes lives here. In yaml this is
 * the runtime entry's `config` block, mirroring a mount's.
 *
 * The base names no field, because no knob is shared by every tier.
 * Python gets its fail-loud check from the dataclass (a field the
 * runtime does not have is a TypeError); TypeScript has no runtime
 * view of an interface, so each runtime hands the base its own key
 * list and coerceRuntimeConfig enforces it.
 */
export type RuntimeConfig = object

/**
 * Config for runtimes whose engine lives in a directory or binary.
 *
 * Args:
 *   home: where the engine is (a wasm build dir, an interpreter
 *     path). Absent falls back to the runtime's own environment
 *     variable, then its built-in default.
 */
export interface HomeConfig extends RuntimeConfig {
  home?: string
}

export const HOME_CONFIG_KEYS: readonly string[] = ['home']

/**
 * A constructor's config option as the runtime's own config, mirroring
 * Python's RuntimeConfig.coerce: keys outside the runtime's list fail
 * loud (Python gets this from the dataclass raising TypeError; a TS
 * object spread would silently swallow a typo key without it).
 *
 * Args:
 *   value: the caller's config block, or undefined for the defaults.
 *   keys: the field names this runtime accepts.
 *   label: what to call the config in the failure message.
 */
export function coerceRuntimeConfig<C extends RuntimeConfig>(
  value: C | undefined,
  keys: readonly string[],
  label = 'runtime',
): C {
  const config = value ?? ({} as C)
  for (const key of Object.keys(config)) {
    if (!keys.includes(key)) {
      const known =
        keys.length > 0 ? `expected: ${keys.map((k) => `'${k}'`).join(', ')}` : 'none allowed'
      throw new Error(`unknown ${label} config key '${key}' (${known})`)
    }
  }
  return { ...config }
}
