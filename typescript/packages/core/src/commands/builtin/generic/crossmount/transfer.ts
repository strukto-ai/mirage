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
import { cpGeneric, cpWalk } from '../cp.ts'
import { mvGeneric } from '../mv.ts'
import {
  type CrossResult,
  type DispatchFn,
  flatten,
  readBytesOp,
  readdirOp,
  statOp,
} from './primitives.ts'

// Copy or move path operands that span two mounts. Pure wiring: the shared
// generic cp/mv runs in its primitive (no native copy/rename) mode, reading
// from the source mount and writing to the destination mount through
// dispatch-relayed primitives. Output matches the single-mount commands.
export async function runTransfer(
  cmdName: string,
  scopes: PathSpec[],
  flagKwargs: Record<string, string | boolean | string[]>,
  dispatch: DispatchFn,
): Promise<CrossResult> {
  const flat = flatten(scopes)
  const stat = statOp(dispatch)
  const readBytes = readBytesOp(dispatch)
  const readdir = readdirOp(dispatch)
  const noClobber = flagKwargs.n === true
  const verbose = flagKwargs.v === true
  const write = async (p: PathSpec, data: Uint8Array): Promise<void> => {
    await dispatch('write', p, [data])
  }
  const mkdir = async (p: PathSpec): Promise<void> => {
    await dispatch('mkdir', p)
  }

  if (cmdName === 'cp') {
    const recursive = flagKwargs.r === true || flagKwargs.R === true || flagKwargs.a === true
    // Sources stream through the client here, so record them as reads:
    // apply_io then populates the file cache (a cp is also a full read).
    const reads: Record<string, Uint8Array> = {}
    const recordingRead = async (p: PathSpec): Promise<Uint8Array> => {
      const data = await readBytes(p)
      reads[p.virtual] = data
      return data
    }
    const copy = async (src: PathSpec, target: PathSpec): Promise<void> => {
      await write(target, await recordingRead(src))
    }
    const find = async (src: PathSpec, _options: FindOptions): Promise<string[]> => {
      const tree = await cpWalk(readdir, stat, src)
      return tree.filter((e) => !e.isDir).map((e) => e.path)
    }
    const result = await cpGeneric(
      flat,
      copy,
      find,
      stat,
      recursive,
      noClobber,
      verbose,
      undefined,
      undefined,
      undefined,
      { readBytes: recordingRead, write, mkdir, readdir },
    )
    const [out, io] = result ?? [null, new IOResult()]
    io.reads = { ...io.reads, ...reads }
    io.cache = [...io.cache, ...Object.keys(reads)]
    return [out, io]
  }

  const unlink = async (p: PathSpec): Promise<void> => {
    await dispatch('unlink', p)
  }
  const rmdir = async (p: PathSpec): Promise<void> => {
    await dispatch('rmdir', p)
  }
  const [out, io] = await mvGeneric(
    flat,
    undefined,
    stat,
    noClobber,
    verbose,
    undefined,
    undefined,
    {
      readBytes,
      write,
      mkdir,
      readdir,
      unlink,
      rmdir,
    },
  )
  return [out, io]
}
