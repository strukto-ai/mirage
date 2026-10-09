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
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { GZIP_SUFFIX } from '../constants.ts'
import { linkResolver } from '../utils/links.ts'
import { decompressInputs } from './decompress.ts'

/** zcat is `gzip -cd`, so -f copies input that is not gzip, -q drops the
 * warnings, and -S names the suffix a missing name is retried with. Mirrors
 * Python's zcat_generic. */
export async function zcatGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (path: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, specOf('zcat'))
  return decompressInputs(paths, stream, {
    stdin: opts.stdin,
    toStdout: true,
    force: fl.asBool('f'),
    quiet: fl.asBool('q'),
    suffix: fl.asStr('S') ?? GZIP_SUFFIX,
    resolver: linkResolver(opts),
  })
}
