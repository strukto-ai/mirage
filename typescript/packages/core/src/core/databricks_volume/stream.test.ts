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

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabricksVolumeAccessor } from '../../accessor/databricks_volume.ts'
import { DatabricksVolume, ROOT, spec } from '../../../tests/fixtures/databricks_volume.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { DatabricksVolumeConfig } from '../../vfs/databricks_volume/config.ts'
import { parseConfigWithSchema } from '../../vfs/secrets.ts'
import { readStream } from './stream.ts'

let origin = ''
let volume: DatabricksVolume

beforeAll(async () => {
  origin = await serve('databricks')
})

beforeEach(async () => {
  volume = new DatabricksVolume(origin)
  await volume.reset()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await volume.run.close()
})

// The two tests that shape how the body arrives (its network chunks, a
// consumer that stops) answer every request with one stubbed response: a
// real server decides its own chunking and never shows a cancel.
function stubbedAccessor(response: () => Response): DatabricksVolumeAccessor {
  vi.stubGlobal('fetch', () => Promise.resolve(response()))
  return new DatabricksVolumeAccessor(
    parseConfigWithSchema(DatabricksVolumeConfig, {
      catalog: 'main',
      schema: 'default',
      volume: 'agent_files',
      root_path: '/root',
      host: 'https://dbc.example.com',
      token: 'tok-123',
    }),
  )
}

function bodyResponse(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

async function collect(iter: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = []
  for await (const chunk of iter) out.push(chunk)
  return out
}

describe('readStream', () => {
  it('re-chunks the body at 8192 bytes', async () => {
    await volume.put(`${ROOT}/big.bin`, new Uint8Array(8192 + 100).fill(7))
    const chunks = await collect(readStream(volume.accessor(), spec('/volume/big.bin')))
    expect(chunks.map((c) => c.byteLength)).toEqual([8192, 100])
  })

  it('coalesces small network chunks', async () => {
    const accessor = stubbedAccessor(() =>
      bodyResponse([new Uint8Array([1, 2]), new Uint8Array([3])]),
    )
    const chunks = await collect(readStream(accessor, spec('/volume/small.bin')))
    expect(chunks).toHaveLength(1)
    expect(Array.from(chunks[0] ?? [])).toEqual([1, 2, 3])
  })

  it('cancels the response body when the consumer stops early', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(8192).fill(7))
      },
      cancel() {
        cancelled = true
      },
    })
    const accessor = stubbedAccessor(() => new Response(stream, { status: 200 }))
    const source = readStream(accessor, spec('/volume/big.bin'))[Symbol.asyncIterator]()
    const first = await source.next()
    if (first.done === true) throw new Error('stream ended before its first chunk')
    expect(first.value.byteLength).toBe(8192)
    await source.return?.()
    expect(cancelled).toBe(true)
  })

  it('raises ENOENT for missing files', async () => {
    const err = (await collect(readStream(volume.accessor(), spec('/volume/gone.bin'))).catch(
      (e: unknown) => e,
    )) as Error & { code?: string }
    expect(err.code).toBe('ENOENT')
  })
})
