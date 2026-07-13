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

/**
 * Build the Python runtime for a workspace.
 *
 * @param name - runtime name; undefined means the default (pyodide)
 * @param options - pyodide options; monty uses only `workspaceBridge`
 */
export function selectPythonRuntime(
  name: string | undefined,
  options: PyodideRuntimeOptions = {},
): PythonRuntime {
  const resolved = name ?? DEFAULT_PYTHON_RUNTIME
  if (resolved === PYODIDE_RUNTIME) return new PyodideRuntime(options)
  if (resolved === MONTY_RUNTIME) {
    return new MontyRuntime({
      ...(options.workspaceBridge !== undefined
        ? { workspaceBridge: options.workspaceBridge }
        : {}),
      ...(options.listMounts !== undefined ? { listMounts: options.listMounts } : {}),
    })
  }
  if (resolved === 'local') {
    throw new Error(
      "python runtime 'local' is Python-only (the host CPython subprocess); " +
        "TypeScript supports 'pyodide' (WASM CPython, default) and 'monty' (sandboxed)",
    )
  }
  throw new Error(`unknown python runtime: ${resolved} (expected 'pyodide' or 'monty')`)
}
