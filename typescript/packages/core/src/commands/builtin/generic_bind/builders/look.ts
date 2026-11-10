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

import type { CommandFn } from '../../../config.ts'
import type { GenericCommand } from '../adapter.ts'
import { commandFiles, fileSize, resolveOrEmpty } from '../files.ts'
import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { IOResult } from '../../../../io/types.ts'
import { StreamRefusal } from '../../../../rs/errors.ts'
import { refused } from '../../../../rs/scan.ts'
import { openStreamSync } from '../../../../rs/stream.ts'
import { byteView } from '../../../../shell/bytes.ts'
import { StreamHost, hostedStream } from '../../utils/stream_host.ts'

const look: CommandFn = async (_accessor, paths, texts, ctx) => {
  const files = commandFiles(ctx, paths)
  const resolved = await resolveOrEmpty(files, paths)
  const words = texts.length > 0 ? [...texts, ...resolved.map((path) => path.rawPath)] : []
  const fl = new FlagView(ctx.flags, specOf('look'))
  const stop = fl.asStr('terminate')
  const config = {
    operands: words.map((word) => byteView(word)),
    fold: fl.asBool('ignore_case'),
    alphanum: fl.asBool('alphanum'),
    ...(stop === undefined ? {} : { terminate: byteView(stop) }),
  }
  try {
    openStreamSync('look', config).close()
  } catch (err) {
    if (!(err instanceof StreamRefusal)) throw err
    return [null, refused(err)]
  }
  const sized = files.answers('read_range') ? fileSize(files, ctx, true) : undefined
  const host = new StreamHost(resolved, files.read, ctx, false, 'look', undefined, false, sized)
  const io = new IOResult()
  return [hostedStream('look', config, host, io, ctx.signal), io]
}

export const BUILDER: GenericCommand = {
  name: 'look',
  read: true,
  streams: true,
  fn: look,
}
