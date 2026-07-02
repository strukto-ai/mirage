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

import type { S3Accessor } from '../../../accessor/s3.ts'
import { exists as s3Exists } from '../../../core/s3/exists.ts'
import { resolveGlob } from '../../../core/s3/glob.ts'
import { stream as s3Stream } from '../../../core/s3/stream.ts'
import { write as s3Write } from '../../../core/s3/write.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { readStdinAsync } from '../utils/stream.ts'

const ENC = new TextEncoder()

async function teeCommand(
  accessor: S3Accessor,
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
      existingFound = await s3Exists(accessor, first)
    } catch {
      existingFound = false
    }
    if (existingFound) {
      const existing = await materialize(s3Stream(accessor, first))
      writeData = new Uint8Array(existing.byteLength + raw.byteLength)
      writeData.set(existing, 0)
      writeData.set(raw, existing.byteLength)
    }
  }
  await s3Write(accessor, first, writeData)
  const out: ByteSource = raw
  return [
    out,
    new IOResult({
      writes: { [first.mountPath]: writeData },
      cache: [first.mountPath],
    }),
  ]
}

export const S3_TEE = command({
  name: 'tee',
  resource: ResourceName.S3,
  spec: specOf('tee'),
  fn: teeCommand,
  write: true,
})
