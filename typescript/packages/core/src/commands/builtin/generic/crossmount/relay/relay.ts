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

import type { PathSpec } from '../../../../../types.ts'
import { runCmp } from './cmp.ts'
import { runCp } from './cp.ts'
import { runDiff } from './diff.ts'
import { runMv } from './mv.ts'
import { Cmd, type CrossResult, type DispatchFn } from '../types.ts'

// Run a command whose data must colocate across mounts. Pure wiring: every
// operand is read or written through dispatch primitives on its owning
// mount, and the shared generic does the work in its primitive mode, so
// output matches the single-mount commands.
export async function runRelay(
  cmdName: Cmd,
  scopes: PathSpec[],
  flagKwargs: Record<string, string | boolean | string[]>,
  dispatch: DispatchFn,
): Promise<CrossResult> {
  if (cmdName === Cmd.CP) return runCp(scopes, flagKwargs, dispatch)
  if (cmdName === Cmd.MV) return runMv(scopes, flagKwargs, dispatch)
  if (cmdName === Cmd.DIFF) return runDiff(scopes, flagKwargs, dispatch)
  return runCmp(scopes, flagKwargs, dispatch)
}
