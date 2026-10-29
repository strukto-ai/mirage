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

import { FlagView } from '../../../spec/flag_view.ts'
import { uploadFile as shareFile } from '../../../../core/slack/post.ts'
import { IOResult, type ByteSource } from '../../../../io/types.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import type { PathSpec } from '../../../../types.ts'
import type { SlackAccessor } from '../../../../accessor/slack.ts'
import { compactJsonBytes } from '../../../../core/render/json.ts'
import { fsStrerror, isEnotdir, isMissingPath } from '../../../../errors/fs.ts'
import { posixPhrase } from '../../../../errors/posix.ts'
import { rstripSlash } from '../../../../utils/slash.ts'

export async function uploadFile(
  accessor: SlackAccessor,
  _paths: PathSpec[],
  _texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, ctx.spec)
  const source = fl.asPath('file')
  if (source === undefined) throw new Error('--file expects a file')
  if (ctx.vfs === undefined) throw new Error('--file needs a workspace to read files from')
  let data: Uint8Array
  try {
    data = await ctx.vfs.read(source)
  } catch (err) {
    if (isMissingPath(err) || isEnotdir(err)) {
      throw new Error(`read ${source.virtual}: ${fsStrerror(err) ?? posixPhrase('ENOENT')}`)
    }
    throw err
  }
  const trimmed = rstripSlash(source.virtual)
  const result = await shareFile(
    accessor,
    fl.asStr('channel') ?? '',
    trimmed.slice(trimmed.lastIndexOf('/') + 1),
    data,
    fl.asStr('initial_comment'),
    fl.asStr('thread_ts'),
  )
  const out: ByteSource = compactJsonBytes(result)
  return [out, new IOResult()]
}
