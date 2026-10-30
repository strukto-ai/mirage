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
import { RAMVFS } from '../vfs/ram/ram.ts'
import { Limit, MountMode } from '../types.ts'
import { Workspace } from './workspace/workspace.ts'
import { gzip } from '../utils/compress.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function* slowStdin(): AsyncGenerator<Uint8Array> {
  for (;;) {
    await new Promise((r) => setTimeout(r, 10))
    yield ENC.encode('x'.repeat(1024))
  }
}

function buildWs(line: number | null = null): Workspace {
  const ram = new RAMVFS()
  return new Workspace(
    { '/data': ram },
    {
      mode: MountMode.WRITE,
      ...(line === null ? {} : { commandLimits: { '@line': new Limit({ timeoutSeconds: line }) } }),
    },
  )
}

describe('line deadline', () => {
  it.each([
    'shuf -n 5',
    'cat -n | wc -c',
    'cat -A | wc -c',
    'zgrep -c theta',
    'zgrep -q theta',
    'rg -E latin1 -c theta',
    'rg -E latin1 -q absent',
  ])('stops always-ready input when a Rust filter times out: %s', async (line) => {
    let chunk: Uint8Array = Uint8Array.from('theta,\x80,words\n'.repeat(1024), (char) =>
      char.charCodeAt(0),
    )
    if (line.startsWith('zgrep')) chunk = await gzip(chunk)
    const warm = buildWs()
    try {
      await warm.shell(line, { stdin: chunk })
    } finally {
      await warm.close()
    }
    let reads = 0
    async function* source(): AsyncGenerator<Uint8Array> {
      for (;;) {
        reads += 1
        yield await Promise.resolve(chunk)
      }
    }
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      {
        commandLimits: {
          '@line': new Limit({ timeoutSeconds: 0.1 }),
          '@all': new Limit({ maxLines: null, maxBytes: null }),
        },
      },
    )
    const start = performance.now()
    const stdin = source()
    try {
      const result = await ws.shell(line, { stdin })
      expect(result.exitCode).toBe(124)
      expect(reads).toBeGreaterThan(1)
      expect(performance.now() - start).toBeLessThan(2000)
      const stopped = reads
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(reads).toBeLessThanOrEqual(stopped + 1)
      const settled = reads
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(reads).toBe(settled)
    } finally {
      await stdin.return(undefined)
      await ws.close()
    }
  })

  it.each([true, false])(
    'bounds the outermost line, recorded or not (record %s)',
    async (record) => {
      const ws = buildWs(0.1)
      try {
        const r = await ws.shell('sleep 2', { record })
        expect(r.exitCode).toBe(124)
        expect(DEC.decode(r.stderr)).toContain('line: timed out after 0.1s')
      } finally {
        await ws.close()
      }
    },
  )

  it('bounds a slow final stage', async () => {
    const ws = buildWs(0.1)
    try {
      const r = await ws.shell('cat | cat', { stdin: slowStdin() })
      expect(r.exitCode).toBe(124)
      expect(DEC.decode(r.stderr)).toContain('line: timed out after 0.1s')
    } finally {
      await ws.close()
    }
  })

  it('cuts a loop of fast commands', async () => {
    const ws = buildWs(0.2)
    try {
      const r = await ws.shell('while :; do :; done')
      expect(r.exitCode).toBe(124)
      expect(DEC.decode(r.stderr)).toContain('line: timed out after 0.2s')
    } finally {
      await ws.close()
    }
  })

  it('runs a line to its end under the default deadline', async () => {
    const ws = buildWs()
    try {
      const r = await ws.shell('cat | cat', { stdin: ENC.encode('hi\n') })
      expect(r.exitCode).toBe(0)
      expect(DEC.decode(r.stdout)).toBe('hi\n')
    } finally {
      await ws.close()
    }
  })
})

it('yields during shuf range permutation construction', async () => {
  const warm = buildWs()
  try {
    await warm.shell('shuf -i 1-2')
  } finally {
    await warm.close()
  }
  const ws = buildWs(0.01)
  const start = performance.now()
  try {
    const result = await ws.shell('shuf -i 1-1000000 -n 5')
    expect(result.exitCode).toBe(124)
    expect(performance.now() - start).toBeLessThan(2000)
  } finally {
    await ws.close()
  }
})
