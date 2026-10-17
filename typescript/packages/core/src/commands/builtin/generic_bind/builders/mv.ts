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
import { namespaceOf } from '../../../../workspace/files.ts'

const mv: GenericCommandFn = async (ops, accessor, paths, _texts, ctx) => {
  const rename = requireOp(ops.rename, 'rename')
  const idx = ctx.index ?? undefined
  const parsed = parseFlags(new FlagView(ctx.flags, specOf('mv')))
  const mounts = mountsOf(ctx)
  const links = linksOf(ctx)
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
    links === undefined || ctx.vfs === undefined
      ? undefined
      : transferLinksOf(
          links,
          ctx.vfs.dispatch,
          ctx.cwd.virtual,
          namespaceOf(ctx.vfs).vis() ?? undefined,
        ),
    ctx.stdin,
    mounts === undefined ? undefined : (p: string) => mounts.isRoot(p),
  )
}

export const BUILDER: GenericCommand = {
  name: 'mv',
  write: true,
  fn: mv,
}
