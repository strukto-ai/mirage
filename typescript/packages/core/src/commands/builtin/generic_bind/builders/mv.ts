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
import { mvGeneric, parseFlags } from '../../generic/mv.ts'
import type { CommandFn } from '../../../config.ts'
import type { GenericCommand } from '../adapter.ts'
import { commandFiles, refuseReveal } from '../files.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { specOf } from '../../../spec/builtins.ts'
import { linksOf, mountsOf, visibilityOf } from '../../utils/links.ts'

const mv: CommandFn = async (_accessor, paths, _texts, ctx) => {
  const files = commandFiles(ctx, paths)
  const parsed = parseFlags(new FlagView(ctx.flags, specOf('mv')))
  const mounts = mountsOf(ctx)
  const links = linksOf(ctx)
  return mvGeneric(
    await files.resolveGlob(paths),
    files.stat,
    { rename: files.rename },
    parsed,
    undefined,
    files.readdir,
    (src, dst) => {
      refuseReveal(src, dst, ctx.session?.access())
    },
    links === undefined || ctx.vfs === undefined
      ? undefined
      : transferLinksOf(
          links,
          ctx.vfs.dispatch,
          ctx.cwd.virtual,
          visibilityOf(ctx.vfs) ?? undefined,
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
