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

import type { BridgeDispatchFn } from '../mirage_bridge.ts'
import type {
  PythonReplRunArgs,
  PythonReplRunResult,
  PythonRunArgs,
  PythonRunResult,
} from '../types.ts'

export const PYODIDE_RUNTIME = 'pyodide'
export const MONTY_RUNTIME = 'monty'

/** Runtime names the TypeScript packages can build. */
export const PYTHON_RUNTIMES = [PYODIDE_RUNTIME, MONTY_RUNTIME] as const

/**
 * Pyodide stays the TypeScript default until `@pydantic/monty` can answer
 * builtin `open()` calls (its JS binding cannot return a file handle from
 * an `os` callback yet); the Python implementation already defaults to
 * monty.
 */
export const DEFAULT_PYTHON_RUNTIME = PYTHON_RUNTIMES[0]

/**
 * Options every Python runtime understands. `workspaceBridge` routes the
 * sandbox's file I/O through the workspace dispatch; `listMounts` is the
 * live view of workspace mount prefixes the runtime may service. Concrete
 * runtimes extend this with implementation-specific knobs.
 */
export interface PythonRuntimeOptions {
  workspaceBridge?: BridgeDispatchFn
  listMounts?: () => string[]
}

/**
 * A Python interpreter the workspace can execute `python3` code on.
 *
 * Implementations own their interpreter lifecycle (lazy boot, reuse across
 * runs, teardown in `close`). How an implementation sees workspace files is
 * its own concern: an in-process interpreter bridges reads through the
 * workspace dispatch, while a host subprocess only sees the host filesystem.
 */
export interface PythonRuntime {
  readonly name: string
  run(args: PythonRunArgs): Promise<PythonRunResult>
  runRepl(args: PythonReplRunArgs): Promise<PythonReplRunResult>
  close(): Promise<void>
}
