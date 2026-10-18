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
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { getTestParser } from '../../../tests/workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'

const DEC = new TextDecoder()

async function makeWs(
  mounts: Record<string, RAMVFS> = { '/data': new RAMVFS() },
): Promise<Workspace> {
  const parser = await getTestParser()
  return new Workspace(mounts, {
    mode: MountMode.WRITE,
    shellParserFactory: () => Promise.resolve(parser),
  })
}

function text(bytes: Uint8Array | null): string {
  return bytes === null ? '' : DEC.decode(bytes)
}

describe('the empty operand', () => {
  it('is removed by nothing, rm -f included', async () => {
    // rm -f silences the empty name's ENOENT, and the bookkeeping after a
    // clean rm used to purge the node table under its `virtual`, the
    // working directory, taking every link there with it.
    const ws = await makeWs()
    await ws.shell('mkdir -p /data/d; echo x > /data/d/f; ln -s f /data/d/l')
    const r = await ws.shell("cd /data/d && rm -rf ''")
    expect(r.exitCode).toBe(0)
    expect(ws.namespace.isLink('/data/d/l')).toBe(true)
    expect(text((await ws.shell('cat /data/d/f')).stdout)).toBe('x\n')
  })

  it('routes nowhere, so the line is not cross-mount', async () => {
    // Its `virtual` is the working directory, here the root mount, which
    // used to make the line span mounts it never names.
    const ws = await makeWs()
    await ws.shell('echo a > /data/a.txt')
    const r = await ws.shell("cd / && cat '' /data/a.txt")
    expect(r.exitCode).toBe(1)
    expect(text(r.stdout)).toBe('a\n')
    expect(text(r.stderr)).toBe("cat: '': No such file or directory\n")
  })

  it('does not fan out over the mounts under the cwd', async () => {
    const ws = await makeWs({ '/base': new RAMVFS(), '/base/inner': new RAMVFS() })
    for (const [line, err] of [
      ["du ''", 'du: invalid zero-length file name\n'],
      ["find ''", "find: '': No such file or directory\n"],
    ] as const) {
      const r = await ws.shell(`cd /base && ${line}`)
      expect(r.exitCode).toBe(1)
      expect(text(r.stdout)).toBe('')
      expect(text(r.stderr)).toBe(err)
    }
  })
})

describe('a link loop', () => {
  it('fails its operand, not the line', async () => {
    const ws = await makeWs()
    await ws.shell(
      'echo a > /data/a.txt; echo b > /data/b.txt; ln -s /data/l2 /data/l1; ln -s /data/l1 /data/l2',
    )
    const r = await ws.shell('cat /data/a.txt /data/l1 /data/b.txt')
    expect(r.exitCode).toBe(1)
    expect(text(r.stdout)).toBe('a\nb\n')
    expect(text(r.stderr)).toBe('cat: /data/l1: Too many levels of symbolic links\n')
  })
})
