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

import type { PathSpec } from '../../../types.ts'
import type { Accessor } from '../../../accessor/base.ts'
import { IOResult } from '../../../io/types.ts'
import { command, type CommandFnResult, type Context } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { PathSpec as PathSpecClass } from '../../../types.ts'
import { fsStrerror, isEnotdir, isFsError } from '../../../errors/fs.ts'
import { byteView, encodeText, textView } from '../../../shell/bytes.ts'
import { shellQuoteAlways } from '../../../utils/quote.ts'
import { quoteText } from '../../quote.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { missingOperandError } from '../../spec/usage.ts'

const NAME_MAX = 255
const PATH_MAX = 4096
const PORTABLE_NAME_MAX = 14
const PORTABLE_PATH_MAX = 255
const NON_PORTABLE = /[^A-Za-z0-9._/-]/

function lexical(name: string, portable: boolean, dashes: boolean): string | null {
  const raw = byteView(name)
  if (raw.length === 0 && (portable || dashes)) return 'empty file name'
  const shown = shellQuoteAlways(name)
  if (dashes && raw.split('/').some((part) => part.startsWith('-'))) {
    return `leading '-' in a component of file name ${shown}`
  }
  if (portable) {
    const bad = NON_PORTABLE.exec(raw)
    if (bad !== null) {
      const char = quoteText(textView(bad[0]))
      return `non-portable character '${char}' in file name ${shown}`
    }
    if (raw.length > PORTABLE_PATH_MAX) {
      return `limit ${String(PORTABLE_PATH_MAX)} exceeded by length ${String(raw.length)} of file name ${shown}`
    }
  }
  return null
}

function longComponent(name: string, limit: number): [number, string] | null {
  const parts = byteView(name).split('/')
  for (const [index, part] of parts.entries()) {
    if (part.length > limit) return [index, part]
  }
  return null
}

function componentRefusal(part: string, limit: number): string {
  const shown = shellQuoteAlways(textView(part))
  return `limit ${String(limit)} exceeded by length ${String(part.length)} of file name component ${shown}`
}

// Why this system refuses a name, or null: too long for a parent that exists,
// past the limits, or under a file.
async function onSystem(ctx: Context, name: string): Promise<string | null> {
  const raw = byteView(name)
  if (raw.length === 0) return "'': No such file or directory"
  if (raw.length >= PATH_MAX) return `${name}: File name too long`
  const long = longComponent(name, NAME_MAX)
  if (ctx.vfs === undefined) return long === null ? null : componentRefusal(long[1], NAME_MAX)
  const cwd = ctx.cwd.virtual
  if (long !== null) {
    const parent = name.split('/').slice(0, long[0]).join('/') || (name.startsWith('/') ? '/' : '.')
    if (await ctx.vfs.isDir(PathSpecClass.fromStrPath(parent, undefined, cwd))) {
      return `${name}: File name too long`
    }
    return componentRefusal(long[1], NAME_MAX)
  }
  try {
    await ctx.vfs.stat(PathSpecClass.fromStrPath(name, undefined, cwd))
  } catch (error) {
    if (!isFsError(error)) throw error
    if (isEnotdir(error)) return `${name}: ${String(fsStrerror(error))}`
  }
  return null
}

// Check that names are valid: for this system by default, for every POSIX
// system under -p, for shells under -P. Pinned against coreutils 9.7.
async function pathchk(
  _accessor: Accessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  if (texts.length === 0) throw missingOperandError('pathchk', null)
  const fl = new FlagView(ctx.flags, specOf('pathchk'))
  const both = fl.asBool('portability')
  const portable = both || fl.asBool('p')
  const dashes = both || fl.asBool('P')
  const err: string[] = []
  for (const name of texts) {
    let why = lexical(name, portable, dashes)
    const long = portable ? longComponent(name, PORTABLE_NAME_MAX) : null
    if (why === null && long !== null) why = componentRefusal(long[1], PORTABLE_NAME_MAX)
    if (why === null && !(portable || dashes)) why = await onSystem(ctx, name)
    if (why !== null) err.push(`pathchk: ${why}\n`)
  }
  if (err.length > 0) {
    return [null, new IOResult({ exitCode: 1, stderr: encodeText(err.join('')) })]
  }
  return [null, new IOResult()]
}

export const GENERAL_PATHCHK = command({
  name: 'pathchk',
  vfs: null,
  spec: specOf('pathchk'),
  fn: pathchk,
})
