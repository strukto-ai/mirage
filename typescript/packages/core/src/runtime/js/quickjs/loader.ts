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

let provided: (() => Promise<WebAssembly.Module>) | undefined

/**
 * Use the host's compiled qjs module in place of one loaded from `home`:
 * a runtime that compiles no wasm and starts no worker (an edge isolate)
 * hands in the module it was deployed with, which runs under JSPI in the
 * host's own isolate. Set it before the first run.
 *
 * @param load - resolves to the compiled qjs-wasi module.
 */
export function provideQuickJsModule(load: () => Promise<WebAssembly.Module>): void {
  provided = load
}

/** The module the host provided, if it did. */
export function providedQuickJsModule(): (() => Promise<WebAssembly.Module>) | undefined {
  return provided
}
