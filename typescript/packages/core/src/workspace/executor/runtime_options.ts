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

export type RuntimeOptions = Record<string, Record<string, unknown>>

// Option keys each runtime (in either language) accepts in its yaml
// block / runtimeOptions entry. `home` locates the interpreter or
// distribution (JAVA_HOME-style); monty embeds its interpreter and has
// no options yet. The registry spans both languages so one config stays
// portable: `wasi`/`local` are Python-only, the rest are shared.
const RUNTIME_OPTION_KEYS: Record<string, readonly string[]> = {
  monty: [],
  pyodide: ['home'],
  wasi: ['home'],
  local: ['home'],
  quickjs: ['home'],
}

/**
 * Check per-runtime option blocks (runtime name to key/values).
 *
 * Blocks are allowed for any runtime in either language; only the
 * selected runtime's block is consumed, so one config stays portable
 * across runtimes and languages. Key validation of the selected block
 * happens at selection, where the runtime is known.
 */
export function validateRuntimeOptions(options: RuntimeOptions): RuntimeOptions {
  for (const key of Object.keys(options)) {
    if (RUNTIME_OPTION_KEYS[key] === undefined) {
      const known = Object.keys(RUNTIME_OPTION_KEYS)
        .map((k) => `'${k}'`)
        .join(', ')
      throw new Error(
        `unknown runtime name in runtime options: '${key}' (expected one of ${known})`,
      )
    }
  }
  return options
}

/** Extract and key-check the selected runtime's option block. */
export function resolveRuntimeOptions(
  resolved: string,
  options: RuntimeOptions | undefined,
): Record<string, unknown> {
  const entries = validateRuntimeOptions(options ?? {})
  const opts = { ...(entries[resolved] ?? {}) }
  const known = RUNTIME_OPTION_KEYS[resolved] ?? []
  const unknown = Object.keys(opts)
    .filter((k) => !known.includes(k))
    .sort()
  if (unknown.length > 0) {
    const listed = unknown.map((k) => `'${k}'`).join(', ')
    const accepts =
      known.length > 0
        ? `expected: ${known.map((k) => `'${k}'`).join(', ')}`
        : `the ${resolved} runtime takes no options`
    throw new Error(`unknown ${resolved} runtime option(s): ${listed} (${accepts})`)
  }
  return opts
}
