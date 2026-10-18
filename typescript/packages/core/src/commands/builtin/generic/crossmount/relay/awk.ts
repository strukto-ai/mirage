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

import type { ByteSource } from '../../../../../io/types.ts'
import type { PathSpec } from '../../../../../types.ts'
import type { FlagValue } from '../../../../spec/types.ts'
import { homeOperand } from '../../awk.ts'
import { Cmd, type CrossResult, type RunSingle } from '../types.ts'

/**
 * Run one awk over operands that span mounts, ARGV intact. awk tells its
 * operands apart: FILENAME, FNR, ARGV, nextfile and a `var=value` operand
 * between two files all need each file as its own input, which a merged
 * stream cannot give. So the program runs once, on the mount of its first
 * file, with every operand in order; the files on other mounts read
 * through the dispatcher.
 */
export async function runAwk(
  scopes: PathSpec[],
  textArgs: string[],
  flagKwargs: Record<string, FlagValue>,
  runSingle: RunSingle,
  stdin: ByteSource | null,
): Promise<CrossResult> {
  return runSingle(Cmd.AWK, scopes, textArgs, flagKwargs, {
    stdin,
    resolveHint: homeOperand(scopes),
  })
}
