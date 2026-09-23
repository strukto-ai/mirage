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
import type { NamespaceView } from '../../../../../ops/types.ts'
import type { PathSpec } from '../../../../../types.ts'
import type { FlagValue } from '../../../../spec/types.ts'
import { relayWalkOf } from '../../../generic_bind/archive_io.ts'
import { zipGeneric } from '../../zip_cmd.ts'
import { crossOpts, flatten, statOp, streamOp } from '../utils.ts'
import type { CrossResult, DispatchFn } from '../types.ts'

/**
 * Run a zip whose archive and operands span mounts.
 *
 * Pure wiring: the shared generic plans on dispatch-relayed doors, so
 * each operand is walked on the mount that owns it and the archive lands
 * on its own. The scan still stops at a mount nested under an operand,
 * exactly as it does when the whole line is on one mount.
 */
export async function runZip(
  scopes: PathSpec[],
  flagKwargs: Record<string, FlagValue>,
  dispatch: DispatchFn,
  // The symlinks and mount boundaries the scan merges into each walk.
  ns?: NamespaceView,
): Promise<CrossResult> {
  const result = await zipGeneric(
    flatten(scopes),
    { ...crossOpts(flagKwargs), ...(ns !== undefined ? { ns } : {}) },
    {
      stream: streamOp(dispatch),
      write: async (p, data) => {
        await dispatch('write', p, [data])
      },
      stat: statOp(dispatch),
      walk: relayWalkOf(dispatch, ns?.childMounts),
    },
  )
  return result ?? [null, new IOResult()]
}
