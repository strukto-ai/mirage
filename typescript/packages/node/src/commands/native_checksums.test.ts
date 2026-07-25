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

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { makeEnv, NATIVE_BACKENDS } from './native_fixture.ts'

const ENC = new TextEncoder()

const CHECKSUMS: [string, string][] = [
  ['md5sum', 'md5'],
  ['sha1sum', 'sha1'],
  ['sha256sum', 'sha256'],
  ['sha384sum', 'sha384'],
  ['sha512sum', 'sha512'],
]

function hex(algo: string, data: Uint8Array): string {
  return createHash(algo).update(data).digest('hex')
}

describe.each(NATIVE_BACKENDS)('native checksums (%s backend)', (kind) => {
  it.each(CHECKSUMS)('%s digest matches node crypto', async (cmd, algo) => {
    const env = makeEnv(kind)
    try {
      const payload = ENC.encode('hello\nworld\n')
      env.createFile('f.txt', payload)
      const out = await env.mirage(`${cmd} /data/f.txt`)
      expect(out).toBe(`${hex(algo, payload)}  /data/f.txt\n`)
    } finally {
      await env.cleanup()
    }
  })

  it.each(CHECKSUMS)('%s hashes stdin', async (cmd, algo) => {
    const env = makeEnv(kind)
    try {
      const payload = ENC.encode('piped bytes\n')
      const out = await env.mirage(cmd, payload)
      expect(out).toBe(`${hex(algo, payload)}  -\n`)
    } finally {
      await env.cleanup()
    }
  })

  it.each(CHECKSUMS)('%s -c verifies checksums', async (cmd) => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello\n'))
      const sums = await env.mirage(`${cmd} /data/f.txt`)
      env.createFile('sums.txt', ENC.encode(sums))
      const result = await env.mirage(`${cmd} -c /data/sums.txt`)
      expect(result).toBe('/data/f.txt: OK\n')
    } finally {
      await env.cleanup()
    }
  })
})
