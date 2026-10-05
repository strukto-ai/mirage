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

import { chunks } from '../../../io/cooperative.ts'
import { NOOPAccessor } from '../../../accessor/base.ts'
import { materialize, IOResult } from '../../../io/types.ts'
import type { ByteSource } from '../../../io/types.ts'
import type { FileStat } from '../../../types.ts'
import { FileType, PathSpec } from '../../../types.ts'
import { eisdir } from '../../../utils/errors.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import type { LinkView, MountView, NamespaceView } from '../../../ops/types.ts'
import { rstripSlash, stripSlash } from '../../../utils/slash.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { specOf } from '../../spec/builtins.ts'
import type { FlagValue } from '../../spec/types.ts'
import type { Builder, CommandIO } from './adapter.ts'

/** Use the workspace's policy-checked operations as a generic IO adapter.
 * A listing answers the way a backend's does, which is what every generic is
 * written against: no backend stores a link, and the generics merge the
 * namespace's own from `ns.links`, so the door's copy would be a second row
 * (find) or a followed stat (ls). With `bound` (a walk kept on one
 * filesystem, `du -x`) a listing also leaves out the roots of the mounts
 * below it, which the walk must neither list nor stat. Mirrors Python's
 * dispatch_io. */
export function dispatchIO(
  dispatch: DispatchFn,
  reads?: IOResult,
  links?: LinkView,
  bound?: MountView,
): CommandIO {
  return {
    readdir: async (_accessor, path) => {
      let entries = (await dispatch('readdir', path))[0] as string[]
      if (links !== undefined)
        entries = entries.filter((e) => links.statAt(rstripSlash(e)) === null)
      if (bound !== undefined) {
        const owner = bound.rootOf(path.virtual)
        entries = entries.filter((e) => bound.rootOf(rstripSlash(e)) === owner)
      }
      return entries
    },
    stat: async (_accessor, path) =>
      (await dispatch('stat', path, [], { nofollow: true }))[0] as FileStat,
    readBytes: async (_accessor, path) => {
      if (((await dispatch('stat', path))[0] as FileStat).type === FileType.DIRECTORY)
        throw eisdir(path)
      const body = await materialize((await dispatch('read', path))[0] as ByteSource)
      if (reads !== undefined) {
        reads.reads[path.virtual] = body
        if (!reads.cache.includes(path.virtual)) reads.cache.push(path.virtual)
      }
      return body
    },
    readStream: async function* (_accessor, path) {
      if (((await dispatch('stat', path))[0] as FileStat).type === FileType.DIRECTORY)
        throw eisdir(path)
      yield* chunks((await dispatch('read', path))[0] as ByteSource)
    },
    isMounted: () => true,
    // No cap of its own: a du walk charges each entry to the mount serving
    // it, at that mount's cap (see WalkBudget).
    maxDuEntries: null,
    unlink: async (_accessor, path) => {
      await dispatch('unlink', path)
      if (reads !== undefined) Reflect.deleteProperty(reads.reads, path.virtual)
    },
    mkdir: async (_accessor, path, parents = false) => {
      await dispatch('mkdir', path, [], { parents })
    },
    truncate: async (_accessor, path, size, options) => {
      await dispatch('truncate', path, [size], { no_create: options ?? false })
      if (reads !== undefined) Reflect.deleteProperty(reads.reads, path.virtual)
    },
    write: async (_accessor, path, data) => {
      await dispatch('write', path, [data])
      if (reads !== undefined) Reflect.deleteProperty(reads.reads, path.virtual)
    },
  }
}

function noneBelow(): string[] {
  return []
}

/** Run the existing builder once over the full virtual namespace. Mirrors
 * Python's run_dispatch. The dispatcher lists the mounts below a directory
 * itself, so `ns` offers no descendant to avoid; where each mount begins
 * stays for `--one-file-system`. The output is read before this returns,
 * inside the running command: a `fresh` mount trusts only the listings that
 * command made, so a lazy stream read after it ends would be served the
 * previous command's. */
export async function runDispatch(
  builder: Builder,
  paths: readonly PathSpec[],
  texts: readonly string[],
  bag: Record<string, FlagValue>,
  dispatch: DispatchFn,
  cwd: string,
  ns?: NamespaceView,
  stdin: ByteSource | null = null,
  signal?: AbortSignal,
  argv: readonly string[] = [],
): Promise<[ByteSource | null, IOResult]> {
  const bounded = builder.name === 'du' && new FlagView(bag, specOf('du')).asBool('one_file_system')
  const view =
    ns?.mounts === undefined || bounded
      ? ns
      : {
          ...ns,
          mounts: { ...ns.mounts, descendants: noneBelow, visibleDescendants: noneBelow },
        }
  const reads = new IOResult()
  const result = await builder.fn(
    dispatchIO(dispatch, reads, ns?.links, bounded ? ns?.mounts : undefined),
    new NOOPAccessor(),
    paths.map(
      (p) =>
        new PathSpec({
          virtual: p.virtual,
          directory: p.directory,
          vfsPath: stripSlash(p.virtual),
          pattern: p.pattern,
          resolved: p.resolved,
          rawPath: p.rawPath,
          dotted: p.dotted,
          walkError: p.walkError,
        }),
    ),
    [...texts],
    {
      stdin,
      flags: bag,
      filetypeFns: null,
      mountPrefix: '',
      cwd,
      dispatch,
      argv,
      ...(signal === undefined ? {} : { signal }),
      ...(view === undefined ? {} : { ns: view }),
    },
  )
  if (result === null) return [null, new IOResult()]
  const body = await materialize(result[0])
  const merged = await reads.merge(result[1])
  // Every read went through the dispatcher, whose cold read keeps what the
  // file cache may hold; listing a read path again would keep a filetype
  // renderer's output there, which cat would then print. A written path
  // stays listed. Mirrors Python's run_dispatch.
  merged.cache = merged.cache.filter((p) => !(p in merged.reads))
  return [body, merged]
}
