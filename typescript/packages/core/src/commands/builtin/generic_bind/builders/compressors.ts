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
import { bzip2Generic } from '../../generic/bzip2.ts'
import { compressorFacts } from '../../generic/compressor.ts'
import { xzGeneric } from '../../generic/xz.ts'
import { linkResolver } from '../../utils/links.ts'
import type { GenericCommand } from '../adapter.ts'
import { commandFiles } from '../files.ts'

const GENERICS: ReadonlyMap<string, typeof xzGeneric> = new Map([
  ['xz', xzGeneric],
  ['unxz', xzGeneric],
  ['bzip2', bzip2Generic],
  ['bunzip2', bzip2Generic],
])

function compressor(command: string, generic: typeof xzGeneric): CommandFn {
  return async (_accessor, paths, _texts, ctx) => {
    const files = commandFiles(ctx, paths)
    const resolved = paths.length > 0 ? await files.resolveGlob(paths) : []
    return generic(
      resolved,
      ctx,
      {
        read: files.read,
        write: (p, d) => files.write(p, d),
        unlink: (p) => files.unlink(p),
        stat: files.stat,
        setAttrs: (p, fields) => files.setAttrs(p, fields),
      },
      linkResolver(ctx),
      command,
    )
  }
}

export const BUILDERS: readonly GenericCommand[] = [...GENERICS].map(([name, generic]) => ({
  name,
  write: true,
  facts: compressorFacts,
  fn: compressor(name, generic),
}))
