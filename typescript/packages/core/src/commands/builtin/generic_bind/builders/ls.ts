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

import { facts, lsGeneric, parseProgramFlags } from '../../generic/ls.ts'
import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { treeWalk } from '../../utils/tree.ts'
import type { FileStat } from '../../../../types.ts'
import type { CommandFn } from '../../../config.ts'
import type { GenericCommand } from '../adapter.ts'
import { commandFiles, resolveOrEmpty } from '../files.ts'

const listing =
  (program: string): CommandFn =>
  async (_accessor, paths, _texts, ctx) => {
    const fl = new FlagView(ctx.flags, specOf('ls'))
    const flags = parseProgramFlags(fl, ctx.env ?? {}, program)
    const files = commandFiles(ctx, paths)
    const resolved = await resolveOrEmpty(files, paths)
    // Only -R reads whole subtrees; a plain listing reads one level.
    const recursive = fl.asBool('recursive')
    const [readdir, stat] = treeWalk<string[], FileStat>(
      files.readTree,
      files.readdir,
      files.stat,
      recursive && files.answers('read_tree'),
      files.signal,
    )
    return lsGeneric(resolved, ctx, readdir, stat, undefined, flags, program)
  }

export const BUILDER: GenericCommand = {
  name: 'ls',
  facts: facts,
  fn: listing('ls'),
}

export const DIR_BUILDER: GenericCommand = {
  name: 'dir',
  facts: (fl, operands) => facts(fl, operands, 'dir'),
  fn: listing('dir'),
}

export const VDIR_BUILDER: GenericCommand = {
  name: 'vdir',
  facts: (fl, operands) => facts(fl, operands, 'vdir'),
  fn: listing('vdir'),
}
