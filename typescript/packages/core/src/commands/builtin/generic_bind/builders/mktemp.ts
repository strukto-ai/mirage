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

import { mktempGeneric } from '../../generic/mktemp.ts'
import type { CommandFn } from '../../../config.ts'
import type { GenericCommand } from '../adapter.ts'
import { vfsStatPath } from '../../utils/paths.ts'

const mktemp: CommandFn = (_accessor, _paths, texts, ctx) => {
  // The name a pathless mktemp creates is under $TMPDIR or /tmp, which the
  // working directory's mount rarely owns, so the create goes through the
  // dispatcher to whichever mount does. Mirrors Python's builder.
  const vfs = ctx.vfs
  if (vfs === undefined) throw new TypeError('mktemp: no workspace files')
  const statPath = vfsStatPath(vfs)
  return mktempGeneric(
    texts,
    ctx,
    async (p) => {
      await vfs.dispatch('mkdir', p, [], { parents: false })
    },
    async (p, d) => {
      await vfs.dispatch('write', p, [d])
    },
    async (p) => statPath !== undefined && (await statPath(p)) !== null,
  )
}

export const BUILDER: GenericCommand = {
  name: 'mktemp',
  write: true,
  fn: mktemp,
}
