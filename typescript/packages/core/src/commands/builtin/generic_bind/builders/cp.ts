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

import type { IndexCacheStore } from '../../../../cache/index/store.ts'
import type { StatOverlay } from '../../../../ops/config.ts'
import type { Accessor } from '../../../../accessor/base.ts'
import type { NativeCopy, PathSpec, StatFn } from '../../../../types.ts'
import { walkFind } from '../../../../core/generic/find.ts'
import { cpGeneric, parseCpFlags } from '../../generic/cp.ts'
import type { Builder, CommandIO } from '../adapter.ts'

// The backend stat, merged with the namespace attr overlay if any. cp/mv
// freshness checks (-u) must see touch/chmod overlay state, exactly like
// ls and stat rendering.
export function overlayableStat(
  ops: CommandIO,
  accessor: Accessor,
  index: IndexCacheStore | undefined,
  statOverlay: StatOverlay | undefined,
): StatFn {
  if (statOverlay === undefined) return (p) => ops.stat(accessor, p, index)
  return async (p) => statOverlay(p.virtual, await ops.stat(accessor, p, index))
}

export const CP_BUILDER: Builder = {
  name: 'cp',
  write: true,
  fn: (ops, accessor, paths, _texts, opts) => {
    const { copy, dirCopy, find, isDirName, mkdir } = ops
    if (copy === undefined) {
      throw new Error('cp: backend provides no copy op')
    }
    const idx = opts.index ?? undefined
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
              idx,
            )
    const parsed = parseCpFlags(opts.flags)
    const strategy: NativeCopy = {
      copy: (src: PathSpec, target: PathSpec) => copy(accessor, src, target),
      find: findFn,
      ...(dirCopy === undefined
        ? {}
        : { dirCopy: (src: PathSpec, target: PathSpec) => dirCopy(accessor, src, target) }),
      ...(mkdir === undefined ? {} : { mkdir: (p: PathSpec) => mkdir(accessor, p) }),
    }
    return cpGeneric(
      paths,
      overlayableStat(ops, accessor, idx, opts.statOverlay),
      strategy,
      parsed,
      idx,
      undefined,
      (p: PathSpec) => ops.readdir(accessor, p, idx),
    )
  },
}
