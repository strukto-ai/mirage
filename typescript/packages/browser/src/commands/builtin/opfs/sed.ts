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

import {
  type CommandFnResult,
  type CommandOpts,
  PathSpec,
  ResourceName,
  command,
  makeSedProvision,
  mountKey,
  resolvePath,
  rstripSlash,
  sedGeneric,
  specOf,
} from '@struktoai/mirage-core'
import type { OPFSAccessor } from '../../../accessor/opfs.ts'
import { stat as opfsProvStat } from '../../../core/opfs/stat.ts'
import { stream as opfsStream } from '../../../core/opfs/stream.ts'
import { writeBytes as opfsWrite } from '../../../core/opfs/write.ts'

/**
 * OPFS builds its command list by hand (no generic_bind factory), so it keeps
 * a thin sed wrapper over the shared generic; every factory backend gets the
 * same behavior from the sed builder.
 */
function positionalAsPaths(texts: string[], opts: CommandOpts): PathSpec[] {
  const prefix = opts.mountPrefix !== undefined ? rstripSlash(opts.mountPrefix) : ''
  return texts.map((t) => {
    const resolved = resolvePath(t, opts.cwd)
    const slash = resolved.lastIndexOf('/')
    return new PathSpec({
      virtual: resolved,
      directory: slash >= 0 ? resolved.slice(0, slash + 1) : '/',
      resolved: true,
      resourcePath: mountKey(resolved, prefix),
    })
  })
}

export const OPFS_SED = command<OPFSAccessor>({
  name: 'sed',
  resource: ResourceName.OPFS,
  spec: specOf('sed'),
  provision: makeSedProvision((a: OPFSAccessor, p: PathSpec) => opfsProvStat(a, p)),
  fn: async (
    accessor: OPFSAccessor,
    paths: PathSpec[],
    texts: string[],
    opts: CommandOpts,
  ): Promise<CommandFnResult> => {
    // With -e/-f the positional operand is a file, not the script.
    const usingE = opts.flags.e !== undefined && opts.flags.e !== false
    const usingF = opts.flags.f !== undefined && opts.flags.f !== false
    const operands = usingE || usingF ? [...positionalAsPaths(texts, opts), ...paths] : paths
    return sedGeneric(
      operands,
      texts,
      opts,
      (p) => opfsStream(accessor, p),
      (p, d) => opfsWrite(accessor, p, d),
    )
  },
})
