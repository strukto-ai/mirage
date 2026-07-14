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
import { resolveRuntimeOptions, type RuntimeOptions } from '../../runtime_options.ts'

// The Python-only runtimes' names; they have no TypeScript class to
// take a name from, but cross-language configs may carry their option
// blocks.
const WASI_RUNTIME = 'wasi'
const LOCAL_RUNTIME = 'local'

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
