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
  DEFAULT_JS_RUNTIME,
  QUICKJS_RUNTIME,
  type JsRuntime,
  type JsRuntimeOptions,
} from './interface.ts'
import { QuickJsRuntime } from './quickjs.ts'
import { resolveRuntimeOptions, type RuntimeOptions } from '../runtime_options.ts'

/**
 * Build the JavaScript runtime for a workspace.
 *
 * @param name - runtime name; undefined means the default (quickjs)
 * @param options - workspace bridge + mount list, wiring the engine's
 *   `std.open`/`os.readdir` to the workspace dispatch
 * @param runtimeOptions - per-runtime option blocks; the selected
 *   runtime consumes its own block. Other blocks are ignored.
 */
export function selectJsRuntime(
  name: string | undefined,
  options: JsRuntimeOptions = {},
  runtimeOptions?: RuntimeOptions,
): JsRuntime {
  const resolved = name ?? DEFAULT_JS_RUNTIME
  if (resolved === QUICKJS_RUNTIME) {
    // Validates the quickjs block's keys; `home` is ignored here since
    // quickjs-emscripten bundles its own wasm.
    resolveRuntimeOptions(resolved, runtimeOptions)
    return new QuickJsRuntime(options)
  }
  throw new Error(`unknown js runtime: ${resolved} (expected 'quickjs')`)
}
