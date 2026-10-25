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

import type { CommandFn } from '../../../config.ts'
import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { IOResult } from '../../../../io/types.ts'
import { byteView } from '../../../../shell/bytes.ts'
import { StreamHost, hostedStream } from '../../utils/stream_host.ts'
import type { GenericCommand } from '../adapter.ts'
import { commandFiles, resolveOrEmpty } from '../files.ts'

const FLAGS = [
  'lines',
  'bytes',
  'number',
  'suffix_length',
  'numeric_suffixes',
  'hex_suffixes',
  'additional_suffix',
  'separator',
] as const

const split: CommandFn = async (_accessor, paths, _texts, ctx) => {
  const files = commandFiles(ctx, paths)
  const fl = new FlagView(ctx.flags, specOf('split'))
  const resolved = await resolveOrEmpty(files, paths)
  // mirage-rs reads each value as typed, so an explicitly empty one is
  // refused as GNU refuses it; -d and -x come as `true` without one.
  // Mirrors the Python builder.
  const config: Record<string, util.JSONType> = {}
  for (const name of FLAGS) {
    const value = fl.raw(name)
    if (typeof value === 'string') config[name] = byteView(value)
    else if (value === true) config[name] = true
  }
  config.operands = resolved.map((path) => byteView(path.rawPath))
  // The pieces go to the prefix, or `x` in the working directory, which need
  // not be this mount, so the dispatcher routes each write.
  const host = new StreamHost(resolved, files.read, ctx, true, 'split')
  const io = new IOResult()
  return [hostedStream('split', config, host, io, ctx.signal), io]
}

export const BUILDER: GenericCommand = {
  name: 'split',
  write: true,
  fn: split,
}
