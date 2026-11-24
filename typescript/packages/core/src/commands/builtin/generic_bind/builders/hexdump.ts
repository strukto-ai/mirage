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

import { type util } from 'zod'

import { specOf } from '../../../spec/builtins.ts'
import { FlagView, specFlagNames } from '../../../spec/flag_view.ts'
import { IOResult } from '../../../../io/types.ts'
import { byteView } from '../../../../shell/bytes.ts'
import { StreamHost, hostedStream } from '../../utils/stream_host.ts'
import type { CommandFn } from '../../../config.ts'
import { type GenericCommand } from '../adapter.ts'
import { commandFiles, fileSize, resolveOrEmpty } from '../files.ts'

const hexdump: CommandFn = async (_accessor, paths, _texts, ctx) => {
  const files = commandFiles(ctx, paths)
  const resolved = await resolveOrEmpty(files, paths)
  // mirage-rs reads every option in the order typed, so each display option
  // and format string adds its formats where it stands, a format file by the
  // name typed; `-` names a file, as util-linux's hexdump reads it. Mirrors
  // the Python builder.
  const spec = specOf('hexdump')
  const options = new FlagView(ctx.flags, spec)
    .occurrences(...specFlagNames(spec))
    .map(([name, value]) => [name, typeof value === 'boolean' ? value : byteView(String(value))])
  const config: Record<string, util.JSONType> = {
    options,
    operands: resolved.map((path) => byteView(path.rawPath)),
  }
  const sized = files.answers('read_range') ? fileSize(files, ctx, true) : undefined
  const host = new StreamHost(resolved, files.read, ctx, false, 'hexdump', undefined, false, sized)
  const io = new IOResult()
  return [hostedStream('hexdump', config, host, io, ctx.signal), io]
}

export const BUILDER: GenericCommand = {
  name: 'hexdump',
  read: true,
  streams: true,
  givesBack: true,
  fn: hexdump,
}
