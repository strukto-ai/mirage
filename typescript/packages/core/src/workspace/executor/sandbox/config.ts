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
 * How the sandbox machine is built: the fields every provider has.
 *
 * This base carries only what all providers support; each provider
 * extends it with its own fields (DockerConfig, DaytonaConfig,
 * E2BConfig) and its own key list, so an option a provider cannot
 * honor fails loud at construction. In yaml this is the runtime
 * entry's `config` block, mirroring a mount's.
 */
export interface SandboxConfig {
  /** Environment set in the sandbox. */
  env?: Record<string, string>
}

/** A provider config with the shared collection fields always present. */
export type NormalizedSandboxConfig<C extends SandboxConfig = SandboxConfig> = C &
  Required<Pick<SandboxConfig, 'env'>>

const BASE_CONFIG_KEYS: readonly string[] = ['env']

/**
 * A constructor's config option as the provider's normalized config,
 * mirroring Python's SandboxConfig.coerce: keys outside the
 * provider's list fail loud (Python gets this from the dataclass
 * raising TypeError; a TS object spread would silently swallow a
 * typo key without it).
 */
export function coerceConfig<C extends SandboxConfig>(
  value: C | undefined,
  keys: readonly string[] = BASE_CONFIG_KEYS,
): NormalizedSandboxConfig<C> {
  const config = value ?? ({} as C)
  for (const key of Object.keys(config)) {
    if (!keys.includes(key)) {
      const known = keys.map((k) => `'${k}'`).join(', ')
      throw new Error(`unknown sandbox config key '${key}' (expected: ${known})`)
    }
  }
  return { ...config, env: { ...config.env } }
}
