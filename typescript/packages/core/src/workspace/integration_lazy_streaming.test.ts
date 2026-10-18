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

function bigLines(n: number): string {
  const lines: string[] = []
  for (let i = 0; i < n; i++) lines.push(`line ${String(i)}`)
  return lines.join('\n')
}

const FILES: Record<string, string> = {
  'big.txt': bigLines(10_000),
  'small.txt': 'apple\nbanana\napricot\ncherry\n',
  'dupes.txt': 'a\na\nb\nb\nc\n',
  'csv.txt': 'name,age,city\nalice,30,nyc\nbob,25,sf\n',
}

async function fresh(): Promise<{ ws: Awaited<ReturnType<typeof makeIntegrationWS>>['ws'] }> {
  const { ws } = await makeIntegrationWS(FILES)
  return { ws }
}

describe('integration: lazy streaming', () => {
  it("cat | grep 'line 1' | head -n 3", async () => {
    const { ws } = await fresh()
    const result = (await run(ws, "cat /data/big.txt | grep 'line 1' | head -n 3")).trim()
    const lines = result.split('\n')
    expect(lines.length).toBe(3)
    await ws.close()
  })

  it('cat | head -n 5 early termination', async () => {
    const { ws } = await fresh()
    const result = (await run(ws, 'cat /data/big.txt | head -n 5')).trim()
    const lines = result.split('\n')
    expect(lines.length).toBe(5)
    expect(lines[0]).toBe('line 0')
    await ws.close()
  })

  it('cat | cut | head', async () => {
    const { ws } = await fresh()
    const result = (await run(ws, 'cat /data/csv.txt | cut -d , -f 1 | head -n 2')).trim()
    const lines = result.split('\n')
    expect(lines.length).toBe(2)
    expect(lines[0]).toBe('name')
    expect(lines[1]).toBe('alice')
    await ws.close()
  })

  it('cat | sort | head', async () => {
    const { ws } = await fresh()
    const result = (await run(ws, 'cat /data/small.txt | sort | head -n 2')).trim()
    const lines = result.split('\n')
    expect(lines.length).toBe(2)
    expect(lines).toEqual([...lines].sort())
    await ws.close()
  })

  it('cat | uniq', async () => {
    const { ws } = await fresh()
    const result = (await run(ws, 'cat /data/dupes.txt | uniq')).trim()
    expect(result.split('\n')).toEqual(['a', 'b', 'c'])
    await ws.close()
  })

  it('cat | tr a A | grep Ap', async () => {
    const { ws } = await fresh()
    const result = await run(ws, 'cat /data/small.txt | tr a A | grep Ap')
    const found = result.includes('Apple') || result.includes('Apricot')
    expect(found).toBe(true)
    await ws.close()
  })

  it('cat | grep a | wc -l', async () => {
    const { ws } = await fresh()
    const result = (await run(ws, 'cat /data/small.txt | grep a | wc -l')).trim()
    expect(result).toBe('3')
    await ws.close()
  })

  it("find -name '*.txt'", async () => {
    const { ws } = await fresh()
    const result = await run(ws, "find /data -name '*.txt'")
    expect(result).toContain('/data/')
    await ws.close()
  })
})
