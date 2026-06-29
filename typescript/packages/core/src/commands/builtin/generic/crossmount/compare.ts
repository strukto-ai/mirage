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

import type { PathSpec } from '../../../../types.ts'
import { cmpGeneric } from '../cmp.ts'
import { diffGeneric } from '../diff.ts'
import {
  crossOpts,
  type CrossResult,
  type DispatchFn,
  flatten,
  readdirOp,
  statOp,
  streamOp,
} from './primitives.ts'

// Compare two files that live on different mounts. Both are read through
// dispatch-relayed primitives and handed to the shared generic diff/cmp, so
// output matches the single-mount commands.
export async function runCompare(
  cmdName: string,
  scopes: PathSpec[],
  flagKwargs: Record<string, string | boolean | string[]>,
  dispatch: DispatchFn,
): Promise<CrossResult> {
  const flat = flatten(scopes)
  const opts = crossOpts(flagKwargs)
  const stream = streamOp(dispatch)
  if (cmdName === 'diff') {
    const [out, io] = await diffGeneric(flat, opts, stream, readdirOp(dispatch), statOp(dispatch))
    return [out, io]
  }
  const [out, io] = await cmpGeneric(flat, opts, stream)
  return [out, io]
}
