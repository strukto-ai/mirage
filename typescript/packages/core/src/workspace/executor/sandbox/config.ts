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
 * How the sandbox machine is built: one shape for every provider.
 *
 * Each provider consumes the fields it can honor and rejects the rest
 * loudly. `image` boots an image (docker: local/registry, pulled on
 * first use; daytona: an inline build at create time); `template`
 * names a prebuilt boot source (a Daytona snapshot or an e2b
 * template); `cpu` is cores, `memory`/`disk` are GiB, `gpu` is a count
 * or type spec; `args` are CLI flags passed verbatim where the
 * provider is CLI-driven (docker run flags); `params` are provider
 * create options passed verbatim to the SDK, merged last so they can
 * override anything computed from the fields above. In yaml this is
 * the runtime entry's `config` block, mirroring a mount's.
 */
export interface SandboxConfig {
  image?: string
  template?: string
  env?: Record<string, string>
  cpu?: number
  memory?: number
  disk?: number
  gpu?: number | string
  args?: readonly string[]
  params?: Record<string, unknown>
}

/** A SandboxConfig with its collection fields always present. */
export type NormalizedSandboxConfig = Required<Pick<SandboxConfig, 'env' | 'args' | 'params'>> &
  SandboxConfig

// Python gets unknown-key rejection for free (the dataclass raises
// TypeError); a TS object spread would silently swallow a typo key
// without this list.
const CONFIG_KEYS: readonly string[] = [
  'image',
  'template',
  'env',
  'cpu',
  'memory',
  'disk',
  'gpu',
  'args',
  'params',
]

/**
 * A constructor's config option as a normalized config, mirroring
 * Python's SandboxConfig.coerce: unknown keys fail loud, collection
 * fields are copied and always present.
 */
export function coerceConfig(value: SandboxConfig | undefined): NormalizedSandboxConfig {
  for (const key of Object.keys(value ?? {})) {
    if (!CONFIG_KEYS.includes(key)) {
      const known = CONFIG_KEYS.map((k) => `'${k}'`).join(', ')
      throw new Error(`unknown sandbox config key '${key}' (expected: ${known})`)
    }
  }
  return {
    ...value,
    env: { ...value?.env },
    args: [...(value?.args ?? [])],
    params: { ...value?.params },
  }
}

/** Whether any per-sandbox sizing field is set. */
export function sizedConfig(config: SandboxConfig): boolean {
  return (
    config.cpu !== undefined ||
    config.memory !== undefined ||
    config.disk !== undefined ||
    config.gpu !== undefined
  )
}
