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

import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { GZIP_SUFFIX } from '../constants.ts'
import type { StatFn } from './archive/walk.ts'
import { linkDoor } from '../utils/links.ts'
import { decompressInputs } from './decompress.ts'

interface GunzipFlags {
  readonly keep: boolean
  readonly force: boolean
  readonly toStdout: boolean
  readonly testOnly: boolean
  readonly quiet: boolean
  readonly suffix: string
}

function parseFlags(bag: Record<string, FlagValue>): GunzipFlags {
  const fl = new FlagView(bag, specOf('gunzip'))
  return {
    keep: fl.asBool('k'),
    force: fl.asBool('f'),
    toStdout: fl.asBool('c'),
    testOnly: fl.asBool('t'),
    quiet: fl.asBool('q'),
    suffix: fl.asStr('S') ?? GZIP_SUFFIX,
  }
}

export async function gunzipGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
  unlink: (p: PathSpec) => Promise<void>,
  stat?: StatFn,
): Promise<CommandFnResult> {
  return decompressInputs(paths, stream, {
    stdin: opts.stdin,
    ...parseFlags(opts.flags),
    write,
    unlink,
    ...(stat !== undefined ? { stat } : {}),
    door: linkDoor(opts),
  })
}
