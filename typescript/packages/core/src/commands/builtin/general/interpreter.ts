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

import { IOResult } from '../../../io/types.ts'
import type { RunResult } from '../../../runtime/types.ts'

/**
 * Convert one interpreter outcome into a command's output pair.
 *
 * The single RunResult-to-IOResult mapping: empty stdout becomes null
 * (no stream), the exit code and stderr pass through. The interpreter
 * handlers and the CLI script arm both convert through here so the
 * mapping cannot drift (Python's run_output in
 * commands/builtin/general/interpreter.py).
 */
export function runOutput(result: RunResult): [Uint8Array | null, IOResult] {
  return [
    result.stdout.length > 0 ? result.stdout : null,
    new IOResult({ exitCode: result.exitCode, stderr: result.stderr }),
  ]
}
