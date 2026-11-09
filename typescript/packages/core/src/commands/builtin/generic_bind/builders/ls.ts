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

import { facts, lsGeneric, parseFlags, type LsFlags } from '../../generic/ls.ts'
import { UsageError } from '../../../errors.ts'
import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { treeWalk } from '../../utils/tree.ts'
import type { FileStat } from '../../../../types.ts'
import type { CommandFn } from '../../../config.ts'
import type { GenericCommand } from '../adapter.ts'
import { commandFiles, resolveOrEmpty } from '../files.ts'

// The options dir and vdir list as when nothing else is typed: columns, and
// long, each with names quoted as -b does.
const DIR_FORMAT = 'C'
const VDIR_FORMAT = 'args_l'
const ESCAPED = { QUOTING_STYLE: 'escape' }

function parsed(
  fl: FlagView,
  env: Record<string, string>,
  program: string,
  format?: string,
): LsFlags {
  if (program === 'ls') return parseFlags(fl, env)
  try {
    return parseFlags(fl, { ...ESCAPED, ...env }, format)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    const said = error.message
      .replace('ls: ', `${program}: `)
      .replace("'ls --help'", `'${program} --help'`)
    throw new UsageError(said, error.exitCode)
  }
}

const listing =
  (program: string, format?: string): CommandFn =>
  async (_accessor, paths, _texts, ctx) => {
    const fl = new FlagView(ctx.flags, specOf('ls'))
    const flags = parsed(fl, ctx.env ?? {}, program, format)
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
  facts: (fl, operands) => facts(fl, operands, DIR_FORMAT),
  fn: listing('dir', DIR_FORMAT),
}

export const VDIR_BUILDER: GenericCommand = {
  name: 'vdir',
  facts: (fl, operands) => facts(fl, operands, VDIR_FORMAT),
  fn: listing('vdir', VDIR_FORMAT),
}
