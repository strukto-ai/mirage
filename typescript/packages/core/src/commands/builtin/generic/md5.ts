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

import { IOResult, materialize } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { isStdin } from '../utils/stream.ts'
import { isFsError } from '../../../errors/fs.ts'
import { fsErrorLine } from '../../../errors/render.ts'
import { hashSource, type StoredDigest } from './checksum.ts'
import { concat } from '../../../utils/bytes.ts'

const ENC = new TextEncoder()

export async function md5Generic(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  stat?: (p: PathSpec) => Promise<unknown>,
  stored?: StoredDigest,
): Promise<CommandFnResult> {
  const io = new IOResult()
  const sources: {
    path: PathSpec
    digest: string | null
    source: AsyncIterable<Uint8Array> | null
  }[] = []
  for (const path of paths) {
    try {
      let digest: string | null = null
      if (stored !== undefined && !isStdin(path)) {
        await stat?.(path)
        digest = await stored(path, 'md5')
      }
      sources.push({ path, digest, source: digest === null ? stream(path) : null })
    } catch (err) {
      if (!isFsError(err)) throw err
      io.stderr = concat([await materialize(io.stderr), ENC.encode(fsErrorLine('md5', path, err))])
      io.exitCode = 1
    }
  }
  async function* output(): AsyncIterable<Uint8Array> {
    if (paths.length === 0) {
      const digest = await hashSource(opts.stdin ?? new Uint8Array(), 'md5')
      yield ENC.encode(digest + '  -\n')
      return
    }
    for (const { path: p, digest: storedDigest, source } of sources) {
      try {
        const digest = storedDigest ?? (await hashSource(source ?? new Uint8Array(), 'md5'))
        yield ENC.encode(digest + '  ' + p.rawPath + '\n')
      } catch (err) {
        if (!isFsError(err)) throw err
        io.stderr = concat([await materialize(io.stderr), ENC.encode(fsErrorLine('md5', p, err))])
        io.exitCode = 1
      }
    }
  }
  return [output(), io]
}
