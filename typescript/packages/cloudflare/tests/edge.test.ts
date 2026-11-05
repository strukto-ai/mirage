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

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unstable_dev, type Unstable_DevWorker } from 'wrangler'

interface Result {
  readonly exit: number
  readonly stdout: string
  readonly stderr: string
}

let worker: Unstable_DevWorker
const REDIS_URL = process.env.REDIS_URL

async function run(
  lines: readonly string[],
  maxMemory?: string,
  lineSeconds?: number,
  redis?: { url: string; keyPrefix: string; clear?: boolean },
): Promise<Result[]> {
  const response = await worker.fetch('http://edge.test/run', {
    method: 'POST',
    body: JSON.stringify({
      lines,
      ...(maxMemory !== undefined ? { maxMemory } : {}),
      ...(lineSeconds !== undefined ? { lineSeconds } : {}),
      ...(redis !== undefined ? { redis } : {}),
    }),
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

  it("diffs in the isolate's own thread, which has no worker to start", async () => {
    const [changed, same, missing] = await run([
      'echo a > /data/a; echo b > /data/b; diff /data/a /data/b',
      'diff /data/a /data/a',
      'diff /data/missing /data/a',
    ])
    expect(changed).toEqual({ exit: 1, stdout: '1c1\n< a\n---\n> b\n', stderr: '' })
    expect(same).toEqual({ exit: 0, stdout: '', stderr: '' })
    expect(missing?.stderr).toBe('diff: /data/missing: No such file or directory\n')
  })

  it('keeps two diffs running at once apart, each on its own stream', async () => {
    const [both] = await run([
      'seq 1 4000 > /data/l; seq 1 4000 | sed s/^2000$/x/ > /data/r; ' +
        'seq 1 4000 > /data/m; seq 1 4000 | sed s/^3000$/y/ > /data/n; ' +
        'diff /data/l /data/r > /data/one & diff /data/m /data/n > /data/two & wait; ' +
        'cat /data/one /data/two',
    ])
    expect(both?.stdout).toBe('2000c2000\n< 2000\n---\n> x\n3000c3000\n< 3000\n---\n> y\n')
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
  }, 90_000)

  it("stops a busy python3 loop at its line's deadline, sooner than the cap", async () => {
    const started = Date.now()
    const [loop, next] = await run(
      ["python3 -c 'while True: pass'", "python3 -c 'print(1 + 1)'"],
      undefined,
      2,
    )
    expect(loop?.exit).toBe(124)
    expect(next?.stdout).toBe('2\n')
    expect(Date.now() - started).toBeLessThan(20_000)
  }, 60_000)

  it("follows a client's redirect hop by hop under the workspace's rule", async () => {
    const server: Server = createServer((req, res) => {
      const { port } = server.address() as AddressInfo
      const to = { '/r': '/f', '/away': `http://localhost:${String(port)}/f` }[req.url ?? '']
      res.writeHead(to === undefined ? 200 : 302, to === undefined ? {} : { location: to })
      res.end(to === undefined ? 'file' : '')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const fetched = async (path: string): Promise<unknown> => {
      const response = await worker.fetch('http://edge.test/follow', {
        method: 'POST',
        body: JSON.stringify({ url: `${base}${path}`, allowed: ['127.0.0.1'] }),
      })
      return response.json()
    }
    try {
      expect(await fetched('/r')).toEqual({ status: 200, body: 'file' })
      expect(await fetched('/away')).toEqual({ error: 'TypeError: Failed to fetch' })
    } finally {
      server.close()
    }
  })

  it('refuses a write past max_memory', async () => {
    const [, copy, after] = await run(
      ['seq 1 700000 > /tmp/a', 'cp /tmp/a /tmp/b', 'echo ok'],
      '8MB',
    )
    expect(copy?.exit).toBe(1)
    expect(copy?.stderr).toContain('Disk quota exceeded')
    expect(after?.stdout).toBe('ok\n')
  })

  it('stops output held for its redirect at max_memory', async () => {
    const [fill, after] = await run(['seq 1 10000000 > /tmp/big', 'echo ok'], '8MB')
    expect(fill?.exit).toBe(1)
    expect(fill?.stderr).toBe('line: memory exhausted\n')
    expect(after?.stdout).toBe('ok\n')
  })

  it.skipIf(REDIS_URL === undefined)(
    "mounts redis over Cloudflare's sockets, a fresh connection each request",
    async () => {
      const at = { url: REDIS_URL ?? '', keyPrefix: `mirage:workerd-test:${crypto.randomUUID()}:` }
      const [write] = await run(
        ["mkdir -p /r/out && printf 'b\\na\\n' > /r/out/x.txt && mv /r/out/x.txt /r/out/y.txt"],
        undefined,
        undefined,
        at,
      )
      expect(write?.exit).toBe(0)
      const [read, df] = await run(
        ['sort /r/out/y.txt && ls /r/out', 'df /r'],
        undefined,
        undefined,
        {
          ...at,
          clear: true,
        },
      )
      expect(read?.stdout).toBe('a\nb\ny.txt\n')
      expect(df?.exit).toBe(0)
    },
  )
  for (const on of ['d1', 'object'] as const) {
    const sql = async (id: string, lines: readonly string[]): Promise<Result[]> => {
      const response = await worker.fetch('http://edge.test/sql', {
        method: 'POST',
        body: JSON.stringify({ lines, on, id }),
      })
      expect(response.status).toBe(200)
      return (await response.json()) as Result[]
    }

    it(`keeps files and the session's cwd in SQL on ${on}, across requests`, async () => {
      const id = `t-${on}-${crypto.randomUUID()}`
      const at = (lines: readonly string[]): Promise<Result[]> => sql(id, lines)
      const [write] = await at([
        "mkdir -p /s/p && cd /s/p && head -c 3000000 /dev/zero > big && printf 'b\\na\\n' > f",
      ])
      expect(write?.exit).toBe(0)
      const [read, size] = await at(['pwd && sort f', 'wc -c < /s/p/big'])
      expect(read?.stdout).toBe('/s/p\na\nb\n')
      expect(size?.stdout.trim()).toBe('3000000')
    })

    // A path of `depth` names past the mount: workerd's SQLite answers at
    // most 100 result columns and an expression 100 deep, which every op's
    // walk and `mkdir -p`'s batch have to stay under.
    it.each([19, 20, 31, 32, 96])(`resolves a path %i names deep on ${on}`, async (depth) => {
      const id = `t-${on}-${crypto.randomUUID()}`
      const names = [id, ...Array.from({ length: depth - 2 }, (_, i) => `d${String(i)}`)]
      const dir = `/s/${names.join('/')}`
      const results = await sql(id, [
        `mkdir -p ${dir}/g`,
        `echo hi > ${dir}/f`,
        `cat ${dir}/f`,
        `stat -c %F ${dir}/g`,
        `mv ${dir}/f ${dir}/h && cat ${dir}/h`,
        `cp ${dir}/h ${dir}/c && cat ${dir}/c`,
        `rm ${dir}/h && ls ${dir}`,
        `rm -r /s/${id} && ls /s/${id}`,
      ])
      expect(results).toEqual([
        { exit: 0, stdout: '', stderr: '' },
        { exit: 0, stdout: '', stderr: '' },
        { exit: 0, stdout: 'hi\n', stderr: '' },
        { exit: 0, stdout: 'directory\n', stderr: '' },
        { exit: 0, stdout: 'hi\n', stderr: '' },
        { exit: 0, stdout: 'hi\n', stderr: '' },
        { exit: 0, stdout: 'c\ng\n', stderr: '' },
        {
          exit: 2,
          stdout: '',
          stderr: `ls: cannot access '/s/${id}': No such file or directory\n`,
        },
      ])
    })
  }
})
