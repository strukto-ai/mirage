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

import type { IOResult } from '../../../io/types.ts'
import { MountMode, PathSpec } from '../../../types.ts'
import { runWithMountGate } from '../../../context/session_context.ts'
import { Files } from '../../../workspace/files.ts'
import type { Context } from '../../config.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { getTestParser } from '../../../../tests/workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { csplitGeneric } from './csplit.ts'

const ENC = new TextEncoder()

async function runCsplit(flags: Context['flags'], cwd = '/data'): Promise<[PathSpec[], IOResult]> {
  const specs: PathSpec[] = []
  const ctx = {
    stdin: ENC.encode('a\nb\n'),
    flags,
    cwd: PathSpec.fromStrPath(cwd),
    vfs: new Files(() => Promise.reject(new Error('no dispatch'))),
  } as Context
  // The command runs on the mount at /data.
  const result = await runWithMountGate('/data/', MountMode.WRITE, () =>
    csplitGeneric(
      [],
      ['2'],
      ctx,
      () => {
        throw new Error('paths are empty; the source is stdin')
      },
      (p) => {
        specs.push(p)
        return Promise.resolve()
      },
      (p) => Promise.reject(new Error(`unlink ${p.virtual}: the run succeeds`)),
    ),
  )
  const [, io] = result as [unknown, IOResult]
  return [specs, io]
}

// With no -f, `xx` in the working directory names every output (GNU).
// Mirrors test_csplit.py.
describe('csplit names outputs in the working directory', () => {
  it.each<[Context['flags'], string, string[]]>([
    [{}, '/data', ['/data/xx00', '/data/xx01']],
    [{}, '/data/sub', ['/data/sub/xx00', '/data/sub/xx01']],
    [
      { prefix: PathSpec.fromStrPath('/data/sub/cs') },
      '/data',
      ['/data/sub/cs00', '/data/sub/cs01'],
    ],
    ...['d/..', 'd/.', 'd/', '.'].map((prefix): [Context['flags'], string, string[]] => [
      { prefix: PathSpec.fromStrPath(prefix, undefined, '/data') },
      '/data',
      [`/data/${prefix}00`, `/data/${prefix}01`],
    ]),
  ])('addresses stdin outputs with %j under %s', async (flags, cwd, named) => {
    const [specs] = await runCsplit(flags, cwd)
    expect(specs.map((p) => p.virtual)).toEqual(named)
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

describe('csplit with stdin', () => {
  it('keeps /dev/stdin a path so no piece lands in /dev', async () => {
    // /dev/stdin runs csplit on the /dev mount, where its pieces would be
    // written, so it is refused as a missing path rather than read.
    const r = await shell(
      'cd /data && csplit /dev/stdin 2; ls /dev',
      new TextEncoder().encode('a\nb\nc\n'),
    )
    expect(r[1]).toBe("csplit: cannot open '/dev/stdin' for reading: No such file or directory\n")
    expect(r[0]).not.toContain('xx00')
  })
})
