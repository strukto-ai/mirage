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

import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unstable_dev, type Unstable_DevWorker } from 'wrangler'

interface Result {
  readonly exit: number
  readonly stdout: string
  readonly stderr: string
}

let worker: Unstable_DevWorker

async function run(lines: readonly string[], maxMemory?: string): Promise<Result[]> {
  const response = await worker.fetch('http://edge.test/run', {
    method: 'POST',
    body: JSON.stringify({ lines, ...(maxMemory !== undefined ? { maxMemory } : {}) }),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as Result[]
}

beforeAll(async () => {
  worker = await unstable_dev(fileURLToPath(new URL('./worker.ts', import.meta.url)), {
    config: fileURLToPath(new URL('./wrangler.toml', import.meta.url)),
    experimental: { disableExperimentalWarning: true },
    logLevel: 'error',
  })
}, 120_000)

afterAll(async () => {
  await worker.stop()
})

describe('mirage in workerd', () => {
  it('runs pipes, awk and jq', async () => {
    const [write, awk, sorted, jq] = await run([
      "printf 'name,team,points\\nann,a,10\\nbob,b,7\\ncat,a,12\\n' > /data/p.csv",
      "awk -F, 'NR>1 {s+=$3; n++} END {print n, s/n}' /data/p.csv",
      'seq 1 100000 | sort -rn | head -3',
      "echo '{\"a\":[1,2,3]}' | jq '.a | length'",
    ])
    expect(write?.exit).toBe(0)
    expect(awk?.stdout).toBe('3 9.66667\n')
    expect(sorted?.stdout).toBe('100000\n99999\n99998\n')
    expect(jq?.stdout).toBe('3\n')
  })

  it('runs python3 on in-process monty, reading the workspace', async () => {
    const [inline, write, script] = await run([
      "python3 -c 'print(sum(range(10)))'",
      "printf 'n\\n4\\n6\\n' > /data/n.csv",
      'python3 -c \'import csv; rows = list(csv.DictReader(open("/data/n.csv"))); print(sum(int(r["n"]) for r in rows))\'',
    ])
    expect(inline).toEqual({ exit: 0, stdout: '45\n', stderr: '' })
    expect(write?.exit).toBe(0)
    expect(script?.stdout).toBe('10\n')
  })

  it("stops a runaway python3 loop with monty's own time limit", async () => {
    const [loop, next] = await run(["python3 -c 'while True: pass'", "python3 -c 'print(1 + 1)'"])
    expect(loop?.exit).toBe(1)
    expect(loop?.stderr).toContain('TimeoutError')
    expect(next?.stdout).toBe('2\n')
  }, 30_000)

  it('refuses a write past max_memory', async () => {
    const [fill, after] = await run(['seq 1 10000000 > /tmp/big', 'echo ok'], '8MB')
    expect(fill?.exit).toBe(1)
    expect(fill?.stderr).toContain('Disk quota exceeded')
    expect(after?.stdout).toBe('ok\n')
  })
})
