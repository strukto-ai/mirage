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

import {
  IOResult,
  ResourceName,
  command,
  materialize,
  readStdinAsync,
  resolveGlobOf,
  specOf,
  type ByteSource,
  type CommandFnResult,
  type CommandOpts,
  type PathSpec,
} from '@struktoai/mirage-core'
import type { GridFSAccessor } from '../../../accessor/gridfs.ts'
import { exists as gridfsExists } from '../../../core/gridfs/exists.ts'
import { stream as gridfsStream } from '../../../core/gridfs/stream.ts'
import { write as gridfsWrite } from '../../../core/gridfs/write.ts'
import { GRIDFS_IO } from './io.ts'

const resolveGlob = resolveGlobOf(GRIDFS_IO)

const ENC = new TextEncoder()

async function teeCommand(
  accessor: GridFSAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  if (paths.length === 0) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('tee: missing operand\n') })]
  }
  const resolved = await resolveGlob(accessor, paths, opts.index ?? undefined)
  const first = resolved[0]
  if (first === undefined) return [null, new IOResult()]
  const stdinData = await readStdinAsync(opts.stdin)
  const raw: Uint8Array = stdinData ?? ENC.encode(texts.join(' '))
  let writeData = raw
  if (opts.flags.a === true) {
    let existingFound = false
    try {
      existingFound = await gridfsExists(accessor, first)
    } catch {
      existingFound = false
    }
    if (existingFound) {
      const existing = await materialize(gridfsStream(accessor, first))
      writeData = new Uint8Array(existing.byteLength + raw.byteLength)
      writeData.set(existing, 0)
      writeData.set(raw, existing.byteLength)
    }
  }
  await gridfsWrite(accessor, first, writeData)
  const out: ByteSource = raw
  return [
    out,
    new IOResult({
      writes: { [first.mountPath]: writeData },
      cache: [first.mountPath],
    }),
  ]
}

export const GRIDFS_TEE = command({
  name: 'tee',
  resource: ResourceName.GRIDFS,
  spec: specOf('tee'),
  fn: teeCommand,
  write: true,
})
