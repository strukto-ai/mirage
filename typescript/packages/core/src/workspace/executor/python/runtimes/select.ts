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

// Runtimes (either language) that locate their interpreter or
// distribution through a `home` entry. Monty embeds its interpreter, so
// it never appears here.
export const RUNTIME_HOME_KEYS = [PYODIDE_RUNTIME, 'wasi', 'local'] as const

/**
 * Check a `home` map (runtime name to interpreter location).
 *
 * Entries are allowed for any runtime, in either language, that
 * resolves its interpreter or distribution from a location; only the
 * selected runtime's entry is consumed, so one config stays portable
 * across runtimes and languages.
 */
export function validateRuntimeHome(home: Record<string, string>): Record<string, string> {
  for (const key of Object.keys(home)) {
    if (key === MONTY_RUNTIME) {
      throw new Error("runtime 'monty' embeds its interpreter and does not take a home entry")
    }
    if (!(RUNTIME_HOME_KEYS as readonly string[]).includes(key)) {
      const known = RUNTIME_HOME_KEYS.map((k) => `'${k}'`).join(', ')
      throw new Error(`unknown runtime name in home: '${key}' (expected one of ${known})`)
    }
  }
  return home
}

/**
 * Build the Python runtime for a workspace.
 *
 * @param name - runtime name; undefined means the default (pyodide)
 * @param options - pyodide options; monty uses only `workspaceBridge`
 * @param home - runtime name to interpreter location; the selected
 *   runtime consumes its own entry (`pyodide`: distribution URL or
 *   directory, falling back to MIRAGE_PYODIDE_HOME then the installed
 *   package/CDN). Other entries are ignored.
 */
export function selectPythonRuntime(
  name: string | undefined,
  options: PyodideRuntimeOptions = {},
  home?: Record<string, string>,
): PythonRuntime {
  const resolved = name ?? DEFAULT_PYTHON_RUNTIME
  const entries = validateRuntimeHome(home ?? {})
  if (resolved === PYODIDE_RUNTIME) {
    return new PyodideRuntime({
      ...options,
      ...(entries[PYODIDE_RUNTIME] !== undefined ? { home: entries[PYODIDE_RUNTIME] } : {}),
    })
  }
  if (resolved === MONTY_RUNTIME) {
    return new MontyRuntime({
      ...(options.workspaceBridge !== undefined
        ? { workspaceBridge: options.workspaceBridge }
        : {}),
      ...(options.listMounts !== undefined ? { listMounts: options.listMounts } : {}),
    })
  }
  if (resolved === 'local' || resolved === 'wasi') {
    throw new Error(
      `python runtime '${resolved}' is Python-only; ` +
        "TypeScript supports 'pyodide' (WASM CPython, default) and 'monty' (sandboxed)",
    )
  }
  throw new Error(`unknown python runtime: ${resolved} (expected 'pyodide' or 'monty')`)
}
