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

import { IOResult } from '../../../../../io/types.ts'
import type { PathSpec } from '../../../../../types.ts'
import { commGeneric } from '../../comm.ts'
import type { CrossResult, DispatchFn } from '../types.ts'
import { crossOpts, flatten, streamOp } from '../utils.ts'

// Compare two sorted files on different mounts via the generic comm. Pure wiring: every operand is read through dispatch-relayed
// primitives on its owning mount, matching the single-mount builder.
export async function runComm(
  scopes: PathSpec[],
  flagKwargs: Record<string, string | boolean | string[]>,
  dispatch: DispatchFn,
): Promise<CrossResult> {
  const result = await commGeneric(flatten(scopes), crossOpts(flagKwargs), streamOp(dispatch))
  return result ?? [null, new IOResult()]
}
