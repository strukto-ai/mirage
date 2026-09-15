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
import type { StatOverlay } from '../../../../ops/types.ts'
import type { Accessor } from '../../../../accessor/base.ts'
import type { NativeCopy, PathSpec, PrimitiveCopy, StatFn } from '../../../../types.ts'
import { hiddenPathsIntersect, pathRulesActive } from '../../../../context/session_context.ts'
import { walkFind } from '../../../../core/generic/find.ts'
import { cpGeneric, parseFlags } from '../../generic/cp.ts'
import type { Builder, CommandIO } from '../adapter.ts'
import { resolveGlobOf } from '../adapter.ts'
import { FlagView } from '../../../spec/types.ts'
import { specOf } from '../../../spec/builtins.ts'

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
  requirements: ['copy'],
  fn: async (ops, accessor, paths, _texts, opts) => {
    const { copy, dirCopy, find, mkdir } = ops
    if (copy === undefined) {
      throw new Error('cp: backend provides no copy op')
    }
    const idx = opts.index ?? undefined
    const resolved = await resolveGlobOf(ops)(accessor, paths, idx)
    // No native find op: fall back to a readdir walk (mirrors Python's
    // _make_find). Passing the index lets stat classify entries from the
    // cache instead of re-fetching, matching the find command.
    const findFn: NativeCopy['find'] =
      find !== undefined
        ? (src, options) => find(accessor, src, options, idx)
        : (src, options) =>
            walkFind(
              src,
              {
                readdir: (spec, i) => ops.readdir(accessor, spec, i),
                stat: (spec, i) => ops.stat(accessor, spec, i),
              },
              options,
              idx,
            )
    const parsed = parseFlags(new FlagView(opts.flags, specOf('cp')))
    // A native copy moves a tree in one backend call and a native find
    // lists it, neither of which passes an entry through the guard the
    // way a read does; while a path rule scopes cp, or a hide could
    // cover an entry under an operand (the native find listed hidden
    // names and the per-file read then printed them in its refusal),
    // the primitive walk copies entry by entry (the cross-mount
    // relay's own path), which is also where GNU's per-entry refusals
    // are worded.
    const { write } = ops
    const guarded = pathRulesActive() || resolved.some((p) => hiddenPathsIntersect(p.virtual))
    const strategy: NativeCopy | PrimitiveCopy =
      guarded && write !== undefined && mkdir !== undefined
        ? {
            readBytes: (p: PathSpec) => ops.readBytes(accessor, p, idx),
            write: (p: PathSpec, data: Uint8Array) => write(accessor, p, data),
            mkdir: (p: PathSpec) => mkdir(accessor, p),
            readdir: (p: PathSpec) => ops.readdir(accessor, p, idx),
          }
        : {
            copy: (src: PathSpec, target: PathSpec) => copy(accessor, src, target),
            find: findFn,
            ...(dirCopy === undefined
              ? {}
              : { dirCopy: (src: PathSpec, target: PathSpec) => dirCopy(accessor, src, target) }),
            ...(mkdir === undefined ? {} : { mkdir: (p: PathSpec) => mkdir(accessor, p) }),
          }
    return cpGeneric(
      resolved,
      overlayableStat(ops, accessor, idx, opts.ns?.statOverlay),
      strategy,
      parsed,
      idx,
      undefined,
      (p: PathSpec) => ops.readdir(accessor, p, idx),
    )
  },
}
