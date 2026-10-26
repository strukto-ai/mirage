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

import { parseLimit } from '../cache/file/utils.ts'

/**
 * A runtime's `maxMemory` in bytes, null for no cap.
 *
 * Spelled as sandlock spells its own (`10M`, `512M`, `1G`), or a count of
 * bytes. Mirrors the Python `memory_limit`.
 *
 * Args:
 *   value: the setting as configured.
 *
 * Throws:
 *   Error: the setting is not a size.
 */
export function memoryLimit(value: string | number | null | undefined): number | null {
  if (value === undefined || value === null) return null
  const size =
    typeof value === 'number'
      ? Number.isSafeInteger(value) && value >= 0
      : /^\d+([KMG]B?)?$/i.test(value.trim())
  if (!size)
    throw new Error(`max_memory must be a size like 10M or 1G, got ${JSON.stringify(value)}`)
  return parseLimit(value)
}

/** Constructor options every runtime accepts (a yaml entry's keys). */
export interface RuntimeOptions<C extends RuntimeConfig = Record<string, unknown>> {
  /**
   * Commands this runtime claims; EXTERNAL_COMMANDS (`@external`)
   * captures unresolved program names. WHOLE_LINE (`@line`) claims every
   * line for a line-executing runtime.
   */
  captures?: readonly string[]
  /**
   * The runtime's implementation knobs (a yaml entry's `config`
   * block), coerced against the runtime's own key list so a field the
   * runtime does not have fails loud.
   */
  config?: C
}

/**
 * How a runtime's engine is set up: its implementation knobs.
 *
 * Every runtime is constructed the same way (captures, config); what
 * differs between runtimes lives here. In yaml this is
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
 * Where a runtime's engine is: the config's `home`, else `envVar`'s value,
 * else undefined for the runtime's built-in default. Mirrors Python's
 * `resolve_home`.
 */
export function resolveHome(config: HomeConfig, envVar: string): string | undefined {
  if (config.home !== undefined && config.home !== '') return config.home
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  const value = proc?.env?.[envVar]
  return value !== undefined && value !== '' ? value : undefined
}

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
  if ('env' in config) {
    const env = config.env
    if (
      env === null ||
      typeof env !== 'object' ||
      Array.isArray(env) ||
      Object.values(env).some((value) => typeof value !== 'string')
    )
      throw new Error('runtime env must map strings to strings')
  }
  return { ...config }
}
