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

import { Cmd } from '../types.ts'

// grep-style: an error (2) dominates, then any match wins (0), then no-match
// (1). Everything else: worst operand wins.
//
// Deliberate divergence from GNU: a per-operand read error (missing file)
// does not raise the exit to 2. The single-mount grep reports the operand on
// stderr and still exits 0 on a match, and integ pins that, so the fan-out
// combine mirrors it rather than GNU's errors-win rule.
export function combinedExit(cmdName: Cmd, codes: number[]): number {
  if (cmdName === Cmd.GREP || cmdName === Cmd.RG) {
    if (codes.some((c) => c > 1)) return Math.max(...codes)
    if (codes.includes(0)) return 0
    return codes.length > 0 ? Math.max(...codes) : 0
  }
  return codes.length > 0 ? Math.max(...codes) : 0
}
