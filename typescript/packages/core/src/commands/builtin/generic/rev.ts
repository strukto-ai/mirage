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

import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { FileStat, PathSpec } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { stdinStat, stdinStream } from '../utils/stream.ts'
import { errorsFirst, operandsIo, perOperand, splitReadable } from '../utils/operands.ts'
import { runStream } from '../../../rs/stream.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'

export async function revGeneric(
  paths: PathSpec[],
  ctx: Context,
  stat: (p: PathSpec) => Promise<FileStat>,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  // util-linux rev opens `-` as a file; only /dev/stdin is stdin.
  const [readable, err] = await splitReadable(paths, stdinStat(stat, false), 'rev')
  if (err !== '' && readable.length === 0) return [null, operandsIo(err)]
  stream = stdinStream(stream, ctx.stdin, false, false)
  const io = new IOResult()
  const zero = new FlagView(ctx.flags, specOf('rev')).asBool('zero')
  const config = zero ? { zero: true } : {}
  const each = (source: ByteSource) => runStream('rev', config, source, ctx.signal)
  return errorsFirst([perOperand(readable, stream, ctx.stdin, io, 'rev', each), io], err)
}
