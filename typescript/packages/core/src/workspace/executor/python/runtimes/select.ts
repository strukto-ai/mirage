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

import {
  DEFAULT_PYTHON_RUNTIME,
  MONTY_RUNTIME,
  PYODIDE_RUNTIME,
  type PythonRuntime,
} from './interface.ts'
import { PyodideRuntime, type PyodideRuntimeOptions } from './pyodide.ts'
import { MontyRuntime } from './monty.ts'

// The Python-only runtimes' names; they have no TypeScript class to
// take a name from, but cross-language configs may carry their option
// blocks.
const WASI_RUNTIME = 'wasi'
const LOCAL_RUNTIME = 'local'

export type RuntimeOptions = Record<string, Record<string, unknown>>

// Option keys each runtime (either language) accepts in its yaml block
// / runtimeOptions entry. `home` locates the interpreter or
// distribution (JAVA_HOME-style); monty embeds its interpreter and has
// no options yet.
const RUNTIME_OPTION_KEYS: Record<string, readonly string[]> = {
  [MONTY_RUNTIME]: [],
  [PYODIDE_RUNTIME]: ['home'],
  [WASI_RUNTIME]: ['home'],
  [LOCAL_RUNTIME]: ['home'],
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
function resolveRuntimeOptions(
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

/**
 * Build the Python runtime for a workspace.
 *
 * @param name - runtime name; undefined means the default (pyodide)
 * @param options - pyodide options; monty uses only `workspaceBridge`
 * @param runtimeOptions - per-runtime option blocks; the selected
 *   runtime consumes its own block (`pyodide`: `home` is the
 *   distribution URL or directory, falling back to MIRAGE_PYODIDE_HOME
 *   then the installed package/CDN). Other blocks are ignored.
 */
export function selectPythonRuntime(
  name: string | undefined,
  options: PyodideRuntimeOptions = {},
  runtimeOptions?: RuntimeOptions,
): PythonRuntime {
  const resolved = name ?? DEFAULT_PYTHON_RUNTIME
  if (resolved === PYODIDE_RUNTIME) {
    const opts = resolveRuntimeOptions(resolved, runtimeOptions)
    if (opts.home !== undefined && typeof opts.home !== 'string') {
      throw new Error(`pyodide runtime option 'home' must be a string`)
    }
    return new PyodideRuntime({
      ...options,
      ...(opts.home !== undefined ? { home: opts.home } : {}),
    })
  }
  if (resolved === MONTY_RUNTIME) {
    resolveRuntimeOptions(resolved, runtimeOptions)
    return new MontyRuntime({
      ...(options.workspaceBridge !== undefined
        ? { workspaceBridge: options.workspaceBridge }
        : {}),
      ...(options.listMounts !== undefined ? { listMounts: options.listMounts } : {}),
    })
  }
  if (resolved === LOCAL_RUNTIME || resolved === WASI_RUNTIME) {
    throw new Error(
      `python runtime '${resolved}' is Python-only; ` +
        "TypeScript supports 'pyodide' (WASM CPython, default) and 'monty' (sandboxed)",
    )
  }
  throw new Error(`unknown python runtime: ${resolved} (expected 'pyodide' or 'monty')`)
}
