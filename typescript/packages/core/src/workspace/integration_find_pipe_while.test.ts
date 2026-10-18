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
import { makeIntegrationWS, run } from '../../tests/workspace/fixtures/integration_fixture.ts'

const FILES: Record<string, string> = {
  'docs/readme.txt': 'hello world\n',
  'docs/notes.txt': 'some notes\n',
  'src/main.py': "print('hello')\n",
  'src/utils/helpers.py': 'def helper(): pass\n',
  'data.json': '{"key": "value"}\n',
}

async function fresh(): Promise<{ ws: Awaited<ReturnType<typeof makeIntegrationWS>>['ws'] }> {
  const { ws } = await makeIntegrationWS(FILES)
  return { ws }
}

describe('integration: find_pipe_while', () => {
  it('find -type f', async () => {
    const { ws } = await fresh()
    const result = (await run(ws, 'find /data -type f | sort')).trim()
    const lines = result.split('\n')
    expect(lines).toContain('/data/data.json')
    expect(lines).toContain('/data/docs/readme.txt')
    expect(lines).toContain('/data/src/main.py')
    expect(lines.length).toBe(5)
    await ws.close()
  })

  it('find -maxdepth 0 -type f (search root is a dir, no matches)', async () => {
    const { ws } = await fresh()
    const result = (await run(ws, 'find /data -maxdepth 0 -type f | sort')).trim()
    expect(result).toBe('')
    await ws.close()
  })

  it('find -maxdepth 1 -type f (direct children only)', async () => {
    const { ws } = await fresh()
    const result = (await run(ws, 'find /data -maxdepth 1 -type f | sort')).trim()
    const lines = result.split('\n')
    expect(lines).toContain('/data/data.json')
    expect(lines).not.toContain('/data/docs/notes.txt')
    expect(lines).not.toContain('/data/docs/readme.txt')
    expect(lines).not.toContain('/data/src/main.py')
    expect(lines).not.toContain('/data/src/utils/helpers.py')
    await ws.close()
  })

  it("find -name '*.txt'", async () => {
    const { ws } = await fresh()
    const result = (await run(ws, "find /data -name '*.txt' | sort")).trim()
    const lines = result.split('\n')
    expect(lines).toEqual(['/data/docs/notes.txt', '/data/docs/readme.txt'])
    await ws.close()
  })

  it('find | sort | while read | echo', async () => {
    const { ws } = await fresh()
    const result = await run(
      ws,
      'find /data -maxdepth 2 -type f | sort | while read f; do echo "=== $f ==="; done',
    )
    const lines = result.trim().split('\n')
    for (const line of lines) {
      expect(line.startsWith('=== ')).toBe(true)
      expect(line.endsWith(' ===')).toBe(true)
    }
    const paths = lines.map((l) => l.slice(4, -4))
    expect(paths).toEqual([...paths].sort())
    expect(paths).toContain('/data/data.json')
    await ws.close()
  })

  it('find -name + sort + while read + file', async () => {
    const { ws } = await fresh()
    const result = await run(
      ws,
      'find /data -maxdepth 2 -type f -name \'*.json\' | sort | while read f; do echo "=== $f ==="; file $f; done',
    )
    const lines = result.trim().split('\n')
    expect(lines).toContain('=== /data/data.json ===')
    expect(lines.some((l) => l.includes('json'))).toBe(true)
    await ws.close()
  })

  it('find | while read | echo content', async () => {
    const { ws } = await fresh()
    const result = await run(
      ws,
      'find /data -name \'*.txt\' -type f | sort | while read f; do echo "FILE: $f"; done',
    )
    const paths = result
      .trim()
      .split('\n')
      .map((l) => l.replace(/^FILE: /, ''))
    expect(paths).toContain('/data/docs/notes.txt')
    expect(paths).toContain('/data/docs/readme.txt')
    await ws.close()
  })

  it('find -type d', async () => {
    const { ws } = await fresh()
    const result = (await run(ws, 'find /data -type d | sort')).trim()
    const lines = result === '' ? [] : result.split('\n')
    for (const line of lines) {
      expect(line).toContain('/data')
    }
    await ws.close()
  })
})
