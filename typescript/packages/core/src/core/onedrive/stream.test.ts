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

import { afterEach, describe, expect, it, vi } from 'vitest'

import { OneDriveAccessor } from '../../accessor/onedrive.ts'
import { runWithRecording } from '../../observe/context.ts'
import { PathSpec } from '../../types.ts'
import { readStream } from './stream.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a recorded OneDrive stream', () => {
  it('records the virtual path of a key named like its mount', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) =>
        Promise.resolve(
          String(input) === 'https://download.test/file'
            ? new Response(new Uint8Array([1, 2, 3]), { status: 200 })
            : new Response(
                JSON.stringify({
                  cTag: 'ctag-1',
                  versions: [{ id: 'v1', lastModifiedDateTime: '2026-01-01T00:00:00Z' }],
                  '@microsoft.graph.downloadUrl': 'https://download.test/file',
                }),
                { status: 200 },
              ),
        ),
      ),
    )
    const spec = new PathSpec({ virtual: '/m/m/k.txt', vfsPath: 'm/k.txt', directory: '/m/m/' })
    const accessor = new OneDriveAccessor({ accessToken: 'token' })
    const [out, records] = await runWithRecording(async () => {
      const chunks: number[] = []
      for await (const chunk of readStream(accessor, spec)) chunks.push(...chunk)
      return chunks
    })
    expect(out).toEqual([1, 2, 3])
    expect(records.map((r) => r.path)).toEqual(['/m/m/k.txt'])
  })
})
