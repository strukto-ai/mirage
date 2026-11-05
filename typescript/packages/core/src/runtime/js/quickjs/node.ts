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

import shim from '../../../generated/quickjs_shim.ts'

// Node's common APIs over qjs's std and os, as a function that takes the
// program's argv and script path. shim.js is embedded at build time
// (scripts/embed-runtime.mjs), since a page has no file to read it from;
// its twin in the python package must stay byte-identical (test_node.py).
export const NODE_SHIM: string = shim

/**
 * The source that sets up Node's globals before a program runs.
 *
 * @param argv - what `process.argv` holds: `node`, the script when there
 *   is one, then the program's arguments.
 * @param script - the script's virtual path, which `__filename` and a
 *   relative `require` start from; null for `-e` and piped programs, which
 *   start from the working directory.
 */
export function nodePreamble(argv: readonly string[], script: string | null): string {
  return `std.evalScript(${JSON.stringify(NODE_SHIM)})(${JSON.stringify(argv)}, ${JSON.stringify(script)});`
}
