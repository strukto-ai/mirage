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

import type { BridgeDispatchFn } from '../python/mirage_bridge.ts'
import type { JsRunArgs, JsRunResult } from './types.ts'

export const QUICKJS_RUNTIME = 'quickjs'

/** JavaScript runtime names the TypeScript packages can build. */
export const JS_RUNTIMES = [QUICKJS_RUNTIME] as const

export const DEFAULT_JS_RUNTIME = JS_RUNTIMES[0]

/**
 * Construction options a JavaScript runtime accepts.
 *
 * `workspaceBridge` and `listMounts` wire the engine's `std.open` /
 * `os.readdir` to the workspace dispatch, so guest file I/O reaches the
 * mounts (the same bridge the sandboxed Python runtimes take). Omit them
 * for an engine with no filesystem.
 */
export interface JsRuntimeOptions {
  workspaceBridge?: BridgeDispatchFn
  listMounts?: () => string[]
}

/**
 * A JavaScript engine the workspace can execute `node`/`js` code on.
 *
 * Implementations own their engine lifecycle (lazy boot, reuse across
 * runs, teardown in `close`). With a workspace bridge the engine sees
 * the workspace mounts through `std.open`/`os.readdir`; without one it
 * sees an empty filesystem.
 */
export interface JsRuntime {
  readonly name: string
  run(args: JsRunArgs): Promise<JsRunResult>
  close(): Promise<void>
}
