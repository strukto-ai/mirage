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

import type { NamespaceView } from '../../../../../ops/types.ts'
import { transferLinksOf } from '../utils.ts'
import type { ByteSource } from '../../../../../io/types.ts'
import type { PathSpec } from '../../../../../types.ts'
import { refuseReveal } from '../../../generic_bind/adapter.ts'
import { mvGeneric, parseFlags } from '../../mv.ts'
import type { CrossResult, DispatchFn } from '../types.ts'
import { flatten, readBytesOp, readdirOp, statOp } from '../utils.ts'
import type { FlagValue } from '../../../../spec/types.ts'
import { FlagView } from '../../../../spec/flag_view.ts'
import { specOf } from '../../../../spec/builtins.ts'

// Move operands that span mounts via the shared generic mv. Pure wiring:
// copy through the transfer primitives, then unlink the source on its own
// mount.
export async function runMv(
  scopes: PathSpec[],
  flagKwargs: Record<string, FlagValue>,
  dispatch: DispatchFn,
  // Maps an operand to its storage identity. Without it a move between
  // two prefixes over one store would copy the object onto itself and
  // then unlink the source, destroying it.
  storageKey?: (path: PathSpec) => string,
  ns?: NamespaceView,
  // Where -i reads its answers.
  stdin: ByteSource | null = null,
): Promise<CrossResult> {
  const flat = flatten(scopes)
  const stat = statOp(dispatch)
  const readBytes = readBytesOp(dispatch)
  const readdir = readdirOp(dispatch)
  const write = async (p: PathSpec, data: Uint8Array): Promise<void> => {
    await dispatch('write', p, [data])
  }
  const mkdir = async (p: PathSpec): Promise<void> => {
    await dispatch('mkdir', p)
  }
  const unlink = async (p: PathSpec): Promise<void> => {
    await dispatch('unlink', p)
  }
  const rmdir = async (p: PathSpec): Promise<void> => {
    await dispatch('rmdir', p)
  }
  return mvGeneric(
    flat,
    stat,
    { readBytes, write, mkdir, readdir, unlink, rmdir },
    parseFlags(new FlagView(flagKwargs, specOf('mv'))),
    undefined,
    storageKey,
    undefined,
    refuseReveal,
    ns?.links == null ? undefined : transferLinksOf(ns.links, dispatch, '/', ns.visibility),
    stdin,
  )
}
