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

import { resolvePath } from '../../../../utils/path.ts'
import { PathSpec } from '../../../../types.ts'
import { mktempGeneric } from '../../generic/mktemp.ts'
import type { Builder } from '../adapter.ts'

export const MKTEMP_BUILDER: Builder = {
  name: 'mktemp',
  write: true,
  requirements: ['mkdir', 'write'],
  fn: (ops, accessor, _paths, texts, opts) => {
    const { mkdir, write } = ops
    if (mkdir === undefined || write === undefined) {
      throw new Error('mktemp: backend provides no write op')
    }
    return mktempGeneric(
      texts,
      opts,
      async (p, parents) => {
        if (opts.dispatch !== undefined)
          await opts.dispatch('mkdir', PathSpec.fromStrPath(resolvePath(p.virtual, opts.cwd)), [], {
            parents: parents ?? false,
          })
        else await mkdir(accessor, p, parents)
      },
      async (p, d) => {
        if (opts.dispatch !== undefined)
          await opts.dispatch('write', PathSpec.fromStrPath(resolvePath(p.virtual, opts.cwd)), [d])
        else await write(accessor, p, d)
      },
    )
  },
}
