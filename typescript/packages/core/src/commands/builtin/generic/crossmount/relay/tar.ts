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

import { type ByteSource, IOResult } from '../../../../../io/types.ts'
import { PathSpec } from '../../../../../types.ts'
import type { FlagValue } from '../../../../spec/types.ts'
import { relayIsDirOf, relayWalkOf } from '../../../generic_bind/archive_io.ts'
import { dispatchedReadTree } from '../../../generic_bind/files.ts'
import { parseFlags, tarGeneric } from '../../tar/tar.ts'
import { crossOpts, flatten, statOp, streamOp } from '../utils.ts'
import type { CrossResult, DispatchFn } from '../types.ts'
import { Files } from '../../../../../workspace/files.ts'
import { linkLocation, linkView, mountView, owedNames } from '../../../utils/links.ts'

/**
 * Run a tar whose archive, operands and -C destination span mounts.
 *
 * Pure wiring: the shared generic runs on dispatch-relayed calls, so the
 * archive is read from or written to its mount, every extracted path lands
 * on whichever mount owns it, and each -c operand is walked on the mount
 * that owns it. The create scan still stops at a mount nested under an
 * operand, exactly as it does on one mount. `cwd` is the session's working
 * directory, which relative names and an extraction without -C resolve
 * against.
 */
export async function runTar(
  scopes: PathSpec[],
  textArgs: string[],
  flagKwargs: Record<string, FlagValue>,
  dispatch: DispatchFn,
  cwd: string,
  // The symlinks and mount boundaries the create scan merges into each walk.
  vfs?: Files,
  stdin: ByteSource | null = null,
): Promise<CrossResult> {
  const links = linkView(vfs)
  const tree =
    vfs === undefined
      ? undefined
      : dispatchedReadTree(
          dispatch,
          mountView(vfs),
          links === undefined ? null : (virtual) => linkLocation(links, virtual),
          true,
        )
  const parsed = parseFlags(flagKwargs)
  const created = parsed.archive !== null && parsed.create ? scopes : []
  const result = await tarGeneric(
    flatten(created),
    textArgs,
    {
      ...crossOpts(flagKwargs),
      cwd: PathSpec.fromStrPath(cwd),
      stdin,
      vfs: vfs ?? new Files(dispatch, null, null, { ledger: false }).servedBy(null),
    },
    {
      stream: streamOp(dispatch),
      stat: statOp(dispatch),
      walk: relayWalkOf(dispatch, (dir: string) => owedNames(vfs, dir), 'tar', tree),
      isDir: relayIsDirOf(dispatch),
    },
    true,
  )
  return result ?? [null, new IOResult()]
}
