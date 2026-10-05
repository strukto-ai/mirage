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

import type { ByteSource } from '../../../../../io/types.ts'
import type { PathSpec } from '../../../../../types.ts'
import { cpGeneric, parseFlags } from '../../cp.ts'
import type { CrossResult, DispatchFn } from '../types.ts'
import { flatten, readBytesOp, readdirOp, statOp } from '../utils.ts'
import type { FlagValue } from '../../../../spec/types.ts'
import type { LinkView, MountView, NamespaceView } from '../../../../../ops/types.ts'
import { FlagView } from '../../../../spec/flag_view.ts'
import { specOf } from '../../../../spec/builtins.ts'
import { rstripSlash } from '../../../../../utils/slash.ts'

// List a directory for cp -x: a mount root below the operands is empty, so
// the copy makes the mount point and reads nothing on the other filesystem,
// as GNU's --one-file-system does.
function ownFilesystem(
  readdir: (p: PathSpec) => Promise<string[]>,
  mounts: MountView,
  starts: ReadonlySet<string>,
  path: PathSpec,
): Promise<string[]> {
  if (!starts.has(path.virtual) && mounts.isRoot(path.virtual)) return Promise.resolve([])
  return readdir(path)
}

// The links below a directory that cp -x reaches: none under a mount root its
// listing leaves empty, at or below the directory.
function ownLinks(
  links: LinkView,
  mounts: MountView,
  starts: ReadonlySet<string>,
  directory: string,
): ReturnType<LinkView['subtree']> {
  const below = `${rstripSlash(directory)}/`
  return links.subtree(directory).filter(([virtual]) => {
    const root = rstripSlash(mounts.rootOf(virtual)) || '/'
    return starts.has(root) || !`${root}/`.startsWith(below)
  })
}

// Copy operands that span mounts via the shared generic cp. Pure wiring: the
// generic runs in its primitive (no native copy) mode, reading from the
// source mount and writing to the destination mount through dispatch-relayed
// primitives.
export async function runCp(
  scopes: PathSpec[],
  flagKwargs: Record<string, FlagValue>,
  dispatch: DispatchFn,
  // Maps an operand to its storage identity so two prefixes over one
  // store compare equal.
  storageKey?: (path: PathSpec) => string,
  // The namespace's links, which a copy that does not follow them recreates
  // by name.
  ns?: NamespaceView,
  // The working directory a typed link source resolves against.
  cwd = '/',
  // Where -i reads its answers.
  stdin: ByteSource | null = null,
): Promise<CrossResult> {
  const flat = flatten(scopes)
  const stat = statOp(dispatch)
  const readBytes = readBytesOp(dispatch)
  const fl = new FlagView(flagKwargs, specOf('cp'))
  const mounts = fl.asBool('one_file_system') ? ns?.mounts : undefined
  const starts = new Set(scopes.map((s) => s.virtual))
  const relayed = readdirOp(dispatch)
  const readdir: typeof relayed =
    mounts === undefined ? relayed : (p) => ownFilesystem(relayed, mounts, starts, p)
  const nsLinks = ns?.links
  const links: LinkView | undefined =
    mounts === undefined || nsLinks === undefined
      ? nsLinks
      : { ...nsLinks, subtree: (d) => ownLinks(nsLinks, mounts, starts, d) }
  const write = async (p: PathSpec, data: Uint8Array): Promise<void> => {
    await dispatch('write', p, [data])
  }
  const mkdir = async (p: PathSpec): Promise<void> => {
    await dispatch('mkdir', p)
  }
  const strategy = { readBytes, write, mkdir, readdir }
  const [out, io] = await cpGeneric(
    flat,
    stat,
    strategy,
    parseFlags(fl),
    undefined,
    storageKey,
    undefined,
    undefined,
    links === undefined ? undefined : { links, dispatch, cwd, relay: strategy, relayStat: stat },
    stdin,
  )
  // Every read went through the dispatcher, whose cold read keeps what the
  // file cache may hold; listing a read path again would keep a filetype
  // renderer's output there, which cat would then print. A written path
  // stays listed. Mirrors Python's run_cp.
  io.cache = io.cache.filter((p) => !(p in io.reads))
  return [out, io]
}
