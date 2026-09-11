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
import type { NamespaceView, SessionView } from '../../../../../ops/types.ts'
import type { FileStat, PathSpec } from '../../../../../types.ts'
import { gnuBasename } from '../../../../../utils/path.ts'
import type { CommandOpts } from '../../../../config.ts'
import type { FlagValue } from '../../../../spec/types.ts'
import { overlaidStat } from '../../../generic_bind/adapter.ts'
import { lsGeneric } from '../../ls.ts'
import type { CrossResult, DispatchFn } from '../types.ts'
import { crossOpts, flatten, readdirOp, statOp } from '../utils.ts'

// readdir supplies the parent's names and stat supplies the target's facts,
// and relaying lets the two land on different mounts: statting a nested
// mount's root reaches a backend that calls its own root `/`, not the name
// the parent listing knows it by. The single-mount path never sees this
// because parent and child are one backend. The name has to win from the
// parent's side, or `-R` descends into `parent + "/"`, which is the parent
// again.
function namedByPath(stat: (p: PathSpec) => Promise<FileStat>) {
  return async (p: PathSpec): Promise<FileStat> => {
    const info = await stat(p)
    const name = gnuBasename(p.virtual)
    if (name === '' || name === '/' || info.name === name) return info
    return info.with({ name })
  }
}

// The name-plane facts minus the mount boundaries; see `runLs`.
function crossingNs(ns: NamespaceView): NamespaceView {
  return {
    ...(ns.links !== undefined ? { links: ns.links } : {}),
    ...(ns.statOverlay !== undefined ? { statOverlay: ns.statOverlay } : {}),
    ...(ns.childMounts !== undefined ? { childMounts: ns.childMounts } : {}),
    ...(ns.user !== undefined ? { user: ns.user } : {}),
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
// `ns` carries the name-plane facts no backend can see. The attr overlay
// matters most here: without it a relayed row would report the raw backend
// mode and silently lose a chmod the namespace holds.
//
// Every fact but `mounts`, which names the boundaries a walk's readdir
// cannot cross. This one's does cross them -- readdir and stat route per
// path -- so the relay descends a nested mount itself, and it has to:
// nothing runs behind a relay to contribute that group the way the
// fan-out does for a single-mount run. Handing it the boundaries would
// stop the descent and drop the group. Python says the same thing by
// omission, calling the generic with explicit keywords.
export async function runLs(
  scopes: PathSpec[],
  flagKwargs: Record<string, FlagValue>,
  dispatch: DispatchFn,
  ns?: NamespaceView,
  // The session plane's door, for the profile the group column renders.
  sessionView?: SessionView,
): Promise<CrossResult> {
  const opts: CommandOpts = {
    ...crossOpts(flagKwargs),
    ...(ns !== undefined ? { ns: crossingNs(ns) } : {}),
    ...(sessionView !== undefined ? { sessionView } : {}),
  }
  const result = await lsGeneric(
    flatten(scopes),
    opts,
    readdirOp(dispatch),
    overlaidStat(namedByPath(statOp(dispatch)), ns?.statOverlay),
  )
  return result ?? [null, new IOResult()]
}
