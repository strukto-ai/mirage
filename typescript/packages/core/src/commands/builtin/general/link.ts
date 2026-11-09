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
import { FileType } from '../../../types.ts'
import { fsStrerror, isEnotdir, isFsError, isMissingPath } from '../../../errors/fs.ts'
import { quoteText } from '../../quote.ts'
import { extraOperandError, missingOperandError } from '../../spec/usage.ts'

function refused(source: PathSpec, target: PathSpec, why: string): IOResult {
  const line =
    `link: cannot create link '${quoteText(target.rawPath)}' ` +
    `to '${quoteText(source.rawPath)}': ${why}\n`
  return new IOResult({ exitCode: 1, stderr: new TextEncoder().encode(line) })
}

// A hard link is a byte copy here, as ln's is, through the session's files.
// Pinned against coreutils 9.7.
async function link(
  _accessor: Accessor,
  paths: PathSpec[],
  _texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const [source, target, extra] = paths
  if (source === undefined) throw missingOperandError('link', null)
  if (target === undefined) throw missingOperandError('link', source.rawPath)
  if (extra !== undefined) throw extraOperandError('link', extra.rawPath)
  if (ctx.vfs === undefined) return [null, new IOResult({ exitCode: 1 })]
  let row
  try {
    row = await ctx.vfs.stat(source)
  } catch (error) {
    if (!isFsError(error)) throw error
    return [null, refused(source, target, String(fsStrerror(error)))]
  }
  let taken = true
  try {
    await ctx.vfs.stat(target, undefined, { nofollow: true })
  } catch (error) {
    if (!isMissingPath(error) && !isEnotdir(error)) throw error
    taken = false
  }
  if (taken) return [null, refused(source, target, 'File exists')]
  if (row.type === FileType.DIRECTORY)
    return [null, refused(source, target, 'Operation not permitted')]
  try {
    await ctx.vfs.write(target, await ctx.vfs.read(source, { stream: true }))
  } catch (error) {
    if (!isFsError(error)) throw error
    return [null, refused(source, target, String(fsStrerror(error)))]
  }
  return [null, new IOResult()]
}

export const GENERAL_LINK = command({
  name: 'link',
  vfs: null,
  spec: specOf('link'),
  fn: link,
  write: true,
})
