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

import { commandIo } from '../../../commands/builtin/generic_bind/adapter.ts'
import { GENERIC_COMMANDS } from '../generic_bind/factory.ts'
import { describe, expect, it } from 'vitest'
import { materialize } from '../../../io/types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import type { PathSpec } from '../../../types.ts'
import { MountMode } from '../../../types.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
const RAM_JOIN = GENERIC_COMMANDS.filter((c) => c.name === 'join' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runJoin(
  vfs: RAMVFS,
  paths: PathSpec[],
  flags: Record<string, string | boolean | number | string[]> = {},
): Promise<{ out: string; exitCode: number }> {
  const cmd = RAM_JOIN[0]
  if (cmd === undefined) throw new Error('join not registered')
  const result = await cmd.fn((vfs as { accessor?: unknown }).accessor as never, paths, [], {
    stdin: null,
    flags,
    io: commandIo(vfs),
    cwd: '/',
  })
  if (result === null) return { out: '', exitCode: -1 }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  return { out: DEC.decode(buf), exitCode: ioResult.exitCode }
}

describe('join', () => {
  it("refuses fewer than 2 paths with GNU's usage error, exit 1", async () => {
    const vfs = new RAMVFS()
    const call = runJoin(vfs, [])
    await expect(call).rejects.toThrow(
      "join: missing operand\nTry 'join --help' for more information.",
    )
    await expect(call).rejects.toMatchObject({ exitCode: 1 })
  })
})

async function shell(
  line: string,
  stdin: Uint8Array | null = null,
  seed: Record<string, string> = {},
): Promise<[string, string, number]> {
  const ws = new Workspace(
    { '/data/': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  try {
    for (const [path, body] of Object.entries(seed)) {
      await ws.shell(`tee ${path} > /dev/null`, { stdin: new TextEncoder().encode(body) })
    }
    const io = await ws.shell(line, { stdin })
    const dec = new TextDecoder()
    return [dec.decode(io.stdout), dec.decode(io.stderr), io.exitCode]
  } finally {
    await ws.close()
  }
}

describe('join with stdin', () => {
  it('reads a dash operand across mounts', async () => {
    // From / the dash sits on the root mount, so the line relays.
    const r = await shell('join - /data/f.txt', ENC.encode('alice 1\nbob 2\n'), {
      '/data/f.txt': 'alice 30\nbob 25\n',
    })
    expect(r).toEqual(['alice 1 30\nbob 2 25\n', '', 0])
  })

  it('refuses two dash operands', async () => {
    const r = await shell('join - -', ENC.encode('a\n'))
    expect(r).toEqual(['', 'join: both files cannot be standard input\n', 1])
  })
})
