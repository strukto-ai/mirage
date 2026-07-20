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

// grep-style: a usage error (2) dominates, then a failed operand (a read
// error, seen as exit 1 with stderr) forces 1 even when another operand
// matched, then any match wins (0), then no-match (1). `-q` keeps GNU's
// match-wins rule over errors. Everything else: worst operand wins.
//
// Deliberate divergence from GNU: a per-operand read error (missing file)
// exits 1, not GNU's 2 — the single-mount grep/rg generics flatten fs
// errors to 1 and this combine mirrors them.
export function combinedExit(
  cmdName: Cmd,
  codes: number[],
  errored?: boolean[],
  quiet = false,
): number {
  if (cmdName === Cmd.GREP || cmdName === Cmd.RG) {
    if (codes.some((c) => c > 1)) return Math.max(...codes)
    if (quiet && codes.includes(0)) return 0
    if (errored?.some(Boolean) === true) return 1
    if (codes.includes(0)) return 0
    return codes.length > 0 ? Math.max(...codes) : 0
  }
  return codes.length > 0 ? Math.max(...codes) : 0
}
