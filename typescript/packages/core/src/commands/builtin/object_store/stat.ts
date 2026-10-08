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

import type { Accessor } from '../../../accessor/base.ts'
import type { PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts, type CommandFn } from '../../config.ts'
import type { Command, CommandIO } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { statGeneric } from '../generic/stat.ts'
import { overMountIo } from '../generic_bind/adapter.ts'
import { overlaidStat, resolveGlobOf } from '../generic_bind/index.ts'

/** Build the index-threaded stat override for one keyed store. */
function build<A extends Accessor>(io: CommandIO<A>): CommandFn<A> {
  const statCore = io.stat
  const resolveGlob = resolveGlobOf(io)

  async function statCommand(
    accessor: A,
    paths: PathSpec[],
    _texts: string[],
    opts: CommandOpts,
  ): Promise<CommandFnResult> {
    const resolved =
      paths.length > 0 ? await resolveGlob(accessor, paths, opts.index ?? undefined) : []
    return statGeneric(
      resolved,
      opts,
      overlaidStat((p) => statCore(accessor, p, opts.index ?? undefined), opts.ns?.statOverlay),
    )
  }

  return statCommand
}

/** The keyed-store `stat` over the running mount's table, guarded by `wrap`. */
export function makeStat(vfs: string, wrap: (io: CommandIO) => CommandIO): Command[] {
  return command({
    name: 'stat',
    vfs,
    spec: specOf('stat'),
    fn: overMountIo(build, wrap),
  })
}
