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

import { fileStreamOp } from '../utils.ts'

import { transferLinksOf } from '../utils.ts'
import type { ByteSource } from '../../../../../io/types.ts'
import type { PathSpec } from '../../../../../types.ts'
import { refuseReveal } from '../../../generic_bind/files.ts'
import { mvGeneric, parseFlags } from '../../mv.ts'
import type { CrossResult, DispatchFn } from '../types.ts'
import { flatScopes, parentFollowed, readdirOp, relayCopy, relayWrite, statOp } from '../utils.ts'
import type { FlagValue } from '../../../../spec/types.ts'
import { FlagView } from '../../../../spec/flag_view.ts'
import { specOf } from '../../../../spec/builtins.ts'
import { readerOf, type Files } from '../../../../../workspace/files.ts'
import type { NamespaceReader } from '../../../../../workspace/dispatcher/reader.ts'
import type { MountView } from '../../../../../view/types.ts'
import { linkView, mountView } from '../../../utils/links.ts'

// Whether a source moves by a rename: it and its target sit on one mount once
// the links above both are followed, and no mount sits below either, which a
// rename (or --exchange's swap) would leave where it is. Mirrors Python's
// _renames.
function renames(
  reader: NamespaceReader,
  mounts: MountView,
  src: PathSpec,
  target: PathSpec,
): boolean {
  const here = parentFollowed(reader, src.virtual)
  const there = parentFollowed(reader, target.virtual)
  return (
    mounts.rootOf(here) === mounts.rootOf(there) &&
    mounts.descendants(here).length === 0 &&
    mounts.descendants(there).length === 0
  )
}

// Move operands that span mounts via the shared generic mv. Pure wiring: a
// source that stays on its mount renames there; any other is copied through
// the transfer primitives, then unlinked on its own mount.
export async function runMv(
  scopes: PathSpec[],
  flagKwargs: Record<string, FlagValue>,
  dispatch: DispatchFn,
  // Maps an operand to its storage identity. Without it a move between
  // two prefixes over one store would copy the object onto itself and
  // then unlink the source, destroying it.
  storageKey?: (path: PathSpec) => string,
  vfs?: Files,
  // Where -i reads its answers.
  stdin: ByteSource | null = null,
  // Refuses a source whose mount cannot condition the delete.
  checkUnlink?: (path: PathSpec) => void,
): Promise<CrossResult> {
  const flat = flatScopes(scopes)
  const stat = statOp(dispatch)
  const readdir = readdirOp(dispatch)
  const write = (p: PathSpec, data: ByteSource): Promise<void> => relayWrite(dispatch, p, data)
  const mkdir = async (p: PathSpec): Promise<void> => {
    await dispatch('mkdir', p)
  }
  const unlink = async (p: PathSpec): Promise<void> => {
    await dispatch('unlink', p)
  }
  const rmdir = async (p: PathSpec): Promise<void> => {
    await dispatch('rmdir', p)
  }
  const mounts = mountView(vfs)
  const links = linkView(vfs)
  return mvGeneric(
    flat,
    stat,
    {
      read: fileStreamOp(dispatch),
      write,
      mkdir,
      readdir,
      unlink,
      rmdir,
      copy: (src: PathSpec, dst: PathSpec) => relayCopy(dispatch, src, dst),
      ...(checkUnlink !== undefined ? { checkUnlink } : {}),
    },
    parseFlags(new FlagView(flagKwargs, specOf('mv'))),
    storageKey,
    undefined,
    refuseReveal,
    links === undefined ? undefined : transferLinksOf(links, dispatch, '/'),
    stdin,
    mounts === undefined ? undefined : (p: string) => mounts.isRoot(p),
    dispatch,
    vfs === undefined || mounts === undefined
      ? undefined
      : (src: PathSpec, target: PathSpec) => renames(readerOf(vfs), mounts, src, target),
  )
}
