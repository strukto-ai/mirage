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

import { IOResult } from '../../../../io/types.ts'
import type { FindOptions } from '../../../../resource/base.ts'
import type { PathSpec } from '../../../../types.ts'
import { cpGeneric } from '../../generic/cp.ts'
import type { Builder } from '../adapter.ts'

export const CP_BUILDER: Builder = {
  name: 'cp',
  write: true,
  fn: (ops, accessor, paths, _texts, opts) => {
    if (paths.length < 2) {
      return Promise.resolve([
        null,
        new IOResult({ exitCode: 1, stderr: new TextEncoder().encode('cp: missing operand\n') }),
      ])
    }
    const { copy, find } = ops
    if (copy === undefined || find === undefined) {
      throw new Error('cp: backend provides no copy/find op')
    }
    const recursive = opts.flags.r === true || opts.flags.R === true || opts.flags.a === true
    return cpGeneric(
      paths,
      (src: PathSpec, target: PathSpec) => copy(accessor, src, target),
      (src: PathSpec, options: FindOptions) => find(accessor, src, options),
      (p: PathSpec) => ops.stat(accessor, p, opts.index ?? undefined),
      recursive,
      opts.flags.n === true,
      opts.flags.v === true,
      opts.index ?? undefined,
    )
  },
}
