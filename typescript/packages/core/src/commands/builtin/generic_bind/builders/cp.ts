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
import type { FileStat, NativeCopy, PathSpec, PrimitiveCopy } from '../../../../types.ts'
import { treeWalk } from '../../utils/tree.ts'
import { walkFind } from '../../../../core/generic/find.ts'
import { stripSlash } from '../../../../utils/slash.ts'
import { cpGeneric, parseFlags } from '../../generic/cp.ts'
import { serves, typedLink, linksOf, mountsOf, dispatchOf, mountRoot } from '../../utils/links.ts'
import type { GenericCommand } from '../adapter.ts'
import { enotsup } from '../../../../errors/fs.ts'
import { commandFiles } from '../files.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { pathsScoped } from '../../../../view/namespace_view.ts'
import { specOf } from '../../../spec/builtins.ts'

export const BUILDER: GenericCommand = {
  name: 'cp',
  write: true,
  fn: async (_accessor, paths, _texts, ctx) => {
    const files = commandFiles(ctx, paths)
    // A native copy or find answers for a whole tree in one call, so the
    // dispatcher declines one whose tree the caller's view restricts; cp
    // takes the entry-by-entry walk up front there, which is where GNU's
    // per-entry refusals are worded.
    const scoped = pathsScoped(paths, mountRoot(ctx))
    const copies = !scoped && files.answers('copy')
    const writes = files.answers('write')
    // A function cp may not use here, refused once the dispatcher has judged
    // the path as the write it would be.
    const refused =
      (name: string) =>
      async (path: PathSpec): Promise<void> => {
        await ctx.vfs?.dispatch('write', path, [], { admit_only: true })
        throw enotsup('backend', name, path)
      }
    // Without a file transfer capability, creating directories would
    // leave an uncopyable destination tree. Keep the refusal guarded.
    const mkdir =
      !copies && !writes ? refused('mkdir') : files.answers('mkdir') ? files.mkdir : undefined
    const resolved = await files.resolveGlob(paths)
    // The tree to copy, walked from the mount's readTree where it answers
    // (mirrors Python's _make_find), so stat classifies entries from the
    // listing instead of re-fetching, matching find.
    const [readdir, stat] = treeWalk<string[], FileStat>(
      files.answers('read_tree') ? files.readTree : undefined,
      (p) => files.readdir(p),
      files.stat,
    )
    const findFn: NativeCopy['find'] = async (src, options) => {
      const refused: string[] = []
      const found = await walkFind(
        src,
        { readdir, stat, ...(options.unreadable === undefined ? {} : { unreadable: refused }) },
        { type: options.type },
      )
      options.unreadable?.push(...refused.map((path) => `/${stripSlash(path)}`))
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
    const strategy: NativeCopy | PrimitiveCopy =
      !copies && writes
        ? {
            readBytes: files.readBytes,
            readStream: files.readStream,
            write: files.write,
            mkdir: (p: PathSpec) => files.mkdir(p),
            readdir: files.readdir,
          }
        : {
            // One file's copy goes to the dispatcher whatever the view
            // restricts: it judges both ends of the copy itself.
            copy: files.copy,
            find: findFn,
            ...(!scoped && files.answers('dir_copy') ? { dirCopy: files.dirCopy } : {}),
            ...(mkdir === undefined ? {} : { mkdir: (p: PathSpec) => mkdir(p) }),
          }
    const links = linksOf(ctx) ?? null
    const cwd = ctx.cwd.virtual
    return cpGeneric(
      resolved,
      files.stat,
      strategy,
      parsed,
      undefined,
      files.readdir,
      links === null ? undefined : (p: PathSpec) => typedLink(links, p, cwd),
      links === null || ctx.vfs === undefined
        ? undefined
        : transferLinksOf(links, ctx.vfs.dispatch, cwd, (virtual) =>
            serves(mountsOf(ctx), mountRoot(ctx), virtual),
          ),
      ctx.stdin,
      dispatchOf(ctx),
    )
  },
}
