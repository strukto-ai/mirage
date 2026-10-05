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

import { SharePointAccessor } from '../../accessor/sharepoint.ts'
import { runWithRecording } from '../../observe/context.ts'
import { PathSpec } from '../../types.ts'
import { readStream } from './stream.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a recorded SharePoint stream', () => {
  it('records the virtual path of a key named like its mount', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) => {
        const url = String(input)
        if (url === 'https://download.test/file') {
          return Promise.resolve(new Response(new Uint8Array([1, 2, 3])))
        }
        const body = url.includes('/sites?')
          ? { value: [{ id: 'site-id', displayName: 'Team' }] }
          : url.includes('/drives?')
            ? { value: [{ id: 'drive-id', name: 'Documents' }] }
            : { cTag: 'c', '@microsoft.graph.downloadUrl': 'https://download.test/file' }
        return Promise.resolve(new Response(JSON.stringify(body)))
      }),
    )
    const accessor = new SharePointAccessor({
      accessToken: 'token',
      site: 'Team',
      drive: 'Documents',
    })
    const spec = new PathSpec({ virtual: '/m/m/k.txt', vfsPath: 'm/k.txt', directory: '/m/m/' })
    const [out, records] = await runWithRecording(async () => {
      const chunks: number[] = []
      for await (const chunk of readStream(accessor, spec)) chunks.push(...chunk)
      return chunks
    })
    expect(out).toEqual([1, 2, 3])
    expect(records.map((r) => r.path)).toEqual(['/m/m/k.txt'])
  })
})
