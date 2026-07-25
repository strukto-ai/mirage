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

import { describe, expect, it } from 'vitest'
import { PathSpec } from '../../../types.ts'
import { parseTeeFlags, writeOutput } from './tee.ts'

const DEC = new TextDecoder()

describe('parseTeeFlags', () => {
  it('accepts -a / --append', () => {
    expect(parseTeeFlags({ a: true })).toEqual({ append: true })
    expect(parseTeeFlags({ append: true })).toEqual({ append: true })
  })

  it('treats -i / -p as accepted no-ops', () => {
    expect(parseTeeFlags({ i: true, p: true })).toEqual({ append: false })
  })

  it('accepts valid --output-error modes', () => {
    for (const mode of ['warn', 'warn-nopipe', 'exit', 'exit-nopipe']) {
      expect(parseTeeFlags({ output_error: mode })).toEqual({ append: false })
    }
  })

  it('accepts bare --output-error', () => {
    expect(parseTeeFlags({ output_error: true })).toEqual({ append: false })
  })

  it('rejects an invalid --output-error mode with the GNU message', () => {
    const result = parseTeeFlags({ output_error: 'bogus' })
    expect(typeof result).toBe('string')
    expect(result).toBe(
      "tee: invalid argument 'bogus' for '--output-error'\n" +
        'Valid arguments are:\n' +
        "  - 'warn'\n  - 'warn-nopipe'\n  - 'exit'\n  - 'exit-nopipe'\n" +
        "Try 'tee --help' for more information.\n",
    )
  })
})

describe('writeOutput', () => {
  const ENC = new TextEncoder()
  const path = PathSpec.fromStrPath('/out.txt')

  it('reports writes and cache on success', async () => {
    const written: Record<string, Uint8Array> = {}
    const [out, io] = await writeOutput(
      (p, d) => {
        written[p.mountPath] = d
        return Promise.resolve()
      },
      path,
      ENC.encode('hi'),
      ENC.encode('hi'),
    )
    expect(DEC.decode(out as Uint8Array)).toBe('hi')
    expect(io.exitCode).toBe(0)
    expect(io.cache).toEqual(['/out.txt'])
  })

  it('passes stdout through and exits 1 on a write error', async () => {
    const [out, io] = await writeOutput(
      () => Promise.reject(new Error('disk full')),
      path,
      ENC.encode('hi'),
      ENC.encode('hi'),
    )
    expect(DEC.decode(out as Uint8Array)).toBe('hi')
    expect(io.exitCode).toBe(1)
    expect(DEC.decode(io.stderr as Uint8Array)).toBe('tee: /out.txt: disk full\n')
  })
})
