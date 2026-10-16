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

import { transferLinksOf } from '../../generic/crossmount/utils.ts'
import type { PathSpec } from '../../../../types.ts'
import { mvGeneric, parseFlags } from '../../generic/mv.ts'
import type { GenericCommand, GenericCommandFn } from '../adapter.ts'
import { refuseReveal, requireOp, resolveGlobOf } from '../adapter.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { specOf } from '../../../spec/builtins.ts'
import { linksOf, mountsOf } from '../../utils/links.ts'

const mv: GenericCommandFn = async (ops, accessor, paths, _texts, opts) => {
  const rename = requireOp(ops.rename, 'rename')
  const idx = opts.index ?? undefined
  const parsed = parseFlags(new FlagView(opts.flags, specOf('mv')))
  const mounts = mountsOf(opts)
  const links = linksOf(opts)
  return mvGeneric(
    await resolveGlobOf(ops)(accessor, paths, idx),
    (p: PathSpec) => ops.stat(accessor, p, idx),
    { rename: (src: PathSpec, target: PathSpec) => rename(accessor, src, target) },
    parsed,
    idx,
    undefined,
    (p: PathSpec) => ops.readdir(accessor, p, idx),
    (src, dst) => {
      refuseReveal(src, dst, ops.access)
    },
    links === undefined || opts.dispatch === undefined
      ? undefined
      : transferLinksOf(links, opts.dispatch, opts.cwd, opts.vfs?.vis() ?? undefined),
    opts.stdin,
    mounts === undefined ? undefined : (p: string) => mounts.isRoot(p),
  )
}

export const BUILDER: GenericCommand = {
  name: 'mv',
  write: true,
  fn: mv,
}
