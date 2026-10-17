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

import { transferLinksOf } from '../../generic/crossmount/utils.ts'
import type { IndexCacheStore } from '../../../../cache/index/store.ts'
import type { FileStat, NativeCopy, PathSpec, PrimitiveCopy } from '../../../../types.ts'
import { treeWalk } from '../../utils/tree.ts'
import { walkFind } from '../../../../core/generic/find.ts'
import { rekey } from '../../../../utils/key_prefix.ts'
import { cpGeneric, parseFlags } from '../../generic/cp.ts'
import { serves, typedLink, linksOf, mountsOf, dispatchOf } from '../../utils/links.ts'
import type { GenericCommand } from '../adapter.ts'
import type { CommandIO } from '../../../config.ts'
import { requireOp, resolveGlobOf } from '../adapter.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { pathsScoped } from '../../../../view/namespace_view.ts'
import { specOf } from '../../../spec/builtins.ts'

export const BUILDER: GenericCommand = {
  name: 'cp',
  write: true,
  fn: async (raw, accessor, paths, _texts, ctx) => {
    // A native copy or find answers for a whole tree in one call, so the
    // dispatcher declines one whose tree the caller's view restricts; cp
    // takes the entry-by-entry walk up front there, which is where GNU's
    // per-entry refusals are worded.
    const ops: CommandIO = { ...raw }
    if (pathsScoped(paths, ctx.mountPrefix ?? '')) {
      delete ops.copy
      delete ops.dirCopy
    }
    const { dirCopy, readTree } = ops
    // Without a file transfer capability, creating directories would
    // leave an uncopyable destination tree. Keep the refusal guarded.
    const mkdir =
      ops.copy === undefined && ops.write === undefined
        ? requireOp<NonNullable<CommandIO['mkdir']>>(undefined, 'mkdir')
        : ops.mkdir
    const copy = requireOp(ops.copy, 'copy')
    const idx = ctx.index ?? undefined
    const resolved = await resolveGlobOf(ops)(accessor, paths, idx)
    // The tree to copy, walked from the mount's readTree where it answers
    // (mirrors Python's _make_find). Passing the index lets stat classify
    // entries from the cache instead of re-fetching, matching find.
    const [readdir, stat] = treeWalk<string[], FileStat>(
      readTree === undefined ? undefined : (p) => readTree(accessor, p, idx),
      (spec: PathSpec, i?: IndexCacheStore) => ops.readdir(accessor, spec, i),
      (spec: PathSpec, i?: IndexCacheStore) => ops.stat(accessor, spec, i),
    )
    const findFn: NativeCopy['find'] = async (src, options) => {
      const refused: string[] = []
      const found = await walkFind(
        src,
        { readdir, stat, ...(options.unreadable === undefined ? {} : { unreadable: refused }) },
        { type: options.type },
        idx,
      )
      options.unreadable?.push(
        ...refused.map((path) => `/${rekey(src.virtual, src.vfsPath, path)}`),
      )
      return found
    }
    const parsed = parseFlags(new FlagView(ctx.flags, specOf('cp')))
    // A native copy moves a tree in one backend call and readTree lists
    // it, neither of which passes an entry through the guard the way a
    // read does; while a path rule scopes cp, or a hide could cover an
    // entry under an operand (a one-call listing names hidden entries and
    // the per-file read then prints them in its refusal),
    // the primitive walk copies entry by entry (the cross-mount
    // relay's own path), which is also where GNU's per-entry refusals
    // are worded.
    const { write } = ops
    const primitive = ops.copy === undefined
    const strategy: NativeCopy | PrimitiveCopy =
      primitive && write !== undefined
        ? {
            readBytes: (p: PathSpec) => ops.readBytes(accessor, p, idx),
            readStream: (p: PathSpec) => ops.readStream(accessor, p, idx),
            write: (p, data) => write(accessor, p, data),
            mkdir: (p: PathSpec) => requireOp(ops.mkdir, 'mkdir')(accessor, p),
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
    const links = linksOf(ctx) ?? null
    const cwd = ctx.cwd.virtual
    return cpGeneric(
      resolved,
      (p: PathSpec) => ops.stat(accessor, p, idx),
      strategy,
      parsed,
      idx,
      undefined,
      (p: PathSpec) => ops.readdir(accessor, p, idx),
      links === null ? undefined : (p: PathSpec) => typedLink(links, p, cwd),
      links === null || ctx.vfs === undefined
        ? undefined
        : transferLinksOf(links, ctx.vfs.dispatch, cwd, ctx.vfs.vis() ?? undefined, (virtual) =>
            serves(mountsOf(ctx), ctx.mountPrefix ?? '', virtual),
          ),
      ctx.stdin,
      dispatchOf(ctx),
    )
  },
}
