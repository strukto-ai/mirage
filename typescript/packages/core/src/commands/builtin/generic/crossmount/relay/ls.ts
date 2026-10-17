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
import type { SessionView } from '../../../../../view/types.ts'
import type { Files } from '../../../../../workspace/files.ts'
import type { FileStat, PathSpec } from '../../../../../types.ts'
import { gnuBasename } from '../../../../../utils/path.ts'
import type { Context } from '../../../../config.ts'
import type { FlagValue } from '../../../../spec/types.ts'
import { dispatchedCall } from '../../../generic_bind/adapter.ts'
import { lsGeneric } from '../../ls.ts'
import type { CrossResult, DispatchFn } from '../types.ts'
import { crossOpts, flatten, readdirOp } from '../utils.ts'

// lstat one entry on the mount that owns it, named by its own path.
//
// readdir supplies the parent's names and stat supplies the target's facts,
// and relaying lets the two land on different mounts: statting a nested
// mount's root reaches a backend that calls its own root `/`, not the name
// the parent listing knows it by. The single-mount path never sees this
// because parent and child are one backend. The name has to win from the
// parent's side, or `-R` descends into `parent + "/"`, which is the parent
// again. Mirrors Python's relayed_stat.
function relayedStat(dispatch: DispatchFn) {
  return async (p: PathSpec): Promise<FileStat> => {
    const info = (await dispatchedCall(dispatch, 'stat', p, [], { nofollow: true })) as FileStat
    const name = gnuBasename(p.virtual)
    if (name === '' || name === '/' || info.name === name) return info
    return info.with({ name })
  }
}

// List operands spanning mounts through the shared generic ls. ls relays
// rather than fans out because its layout is decided across all operands at
// once: GNU prints non-directory operands first as one globally sorted
// block, then names each directory in sorted order, and heads them only
// when the line carried more than one operand. A per-operand run sees one
// operand and cannot know any of that, so the generic has to see the whole
// line -- which it can, because readdir and stat route per path.
//
// `vfs` is the session's files, whose links a listing marks. The
// dispatcher's stat carries the attribute overlay and its listing the mounts
// below, and a run outside a mount has no boundary to stop at, so the relay
// descends a nested mount itself, as nothing runs behind a relay to
// contribute that group the way the fan-out does for a single-mount run.
export async function runLs(
  scopes: PathSpec[],
  flagKwargs: Record<string, FlagValue>,
  dispatch: DispatchFn,
  vfs?: Files,
  // The session view, for the profile the group column renders.
  sessionView?: SessionView,
): Promise<CrossResult> {
  const ctx: Context = {
    ...crossOpts(flagKwargs),
    dispatch,
    ...(vfs !== undefined ? { vfs } : {}),
    ...(sessionView !== undefined ? { sessionView } : {}),
  }
  // The dispatcher's listing names the links among the entries. Mirrors
  // Python's relayed_readdir.
  const result = await lsGeneric(flatten(scopes), ctx, readdirOp(dispatch), relayedStat(dispatch))
  return result ?? [null, new IOResult()]
}
