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
import type { NativeCopy, PathSpec } from '../../../../types.ts'
import { walkFind } from '../../../../core/generic/find.ts'
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
    const { copy, dirCopy, find, isDirName } = ops
    if (copy === undefined) {
      throw new Error('cp: backend provides no copy op')
    }
    // No native find op: fall back to a readdir walk (mirrors Python's
    // _make_find). Passing the index lets stat classify entries from the
    // cache instead of re-fetching, matching the find command.
    const findFn: NativeCopy['find'] =
      find !== undefined
        ? (src, options) => find(accessor, src, options)
        : (src, options) =>
            walkFind(
              src,
              {
                readdir: (spec, i) => ops.readdir(accessor, spec, i),
                stat: (spec, i) => ops.stat(accessor, spec, i),
                isDirName:
                  isDirName === undefined ? () => null : (child) => isDirName(accessor, child),
              },
              options,
              opts.index ?? undefined,
            )
    const recursive = opts.flags.r === true || opts.flags.R === true || opts.flags.a === true
    const strategy: NativeCopy = {
      copy: (src: PathSpec, target: PathSpec) => copy(accessor, src, target),
      find: findFn,
      ...(dirCopy === undefined
        ? {}
        : { dirCopy: (src: PathSpec, target: PathSpec) => dirCopy(accessor, src, target) }),
    }
    return cpGeneric(
      paths,
      (p: PathSpec) => ops.stat(accessor, p, opts.index ?? undefined),
      strategy,
      recursive,
      opts.flags.n === true,
      opts.flags.v === true,
      opts.index ?? undefined,
    )
  },
}
