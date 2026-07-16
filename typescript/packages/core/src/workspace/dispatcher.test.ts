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
import { RAMResource } from '../resource/ram/ram.ts'
import { CommandSafeguard, MountMode, PathSpec } from '../types.ts'
import { getTestParser } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

describe('dispatch applies safeguards on the executing mount', () => {
  it('a symlink into a safeguarded mount gets the target mount safeguard', async () => {
    const parser = await getTestParser()
    const data = new RAMResource()
    const plain = new RAMResource()
    const ws = new Workspace(
      {
        '/data': [data, MountMode.EXEC, { read: new CommandSafeguard({ maxBytes: 8 }) }],
        '/r': plain,
      },
      { mode: MountMode.EXEC, shellParserFactory: () => Promise.resolve(parser) },
    )
    try {
      await ws.execute('echo 0123456789abcdef > /data/big.txt')
      await ws.execute('ln -s /data/big.txt /r/link')
      const direct = (await ws.dispatch('read', '/data/big.txt')) as Uint8Array
      const viaLink = (await ws.dispatch('read', '/r/link')) as Uint8Array
      // The link lives on the unsafeguarded mount, but the read executes
      // on /data: its maxBytes cap must apply either way.
      expect(DEC.decode(viaLink)).toBe(DEC.decode(direct))
      expect(direct.byteLength).toBeLessThan(ENC.encode('0123456789abcdef\n').byteLength)
    } finally {
      await ws.close()
    }
  }, 30_000)
})

describe('dispatch rename addresses dst against the source mount', () => {
  it('cross-mount dst lands where Python lands it (EXDEV is a follow-up)', async () => {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/a': new RAMResource(), '/b': new RAMResource() },
      { mode: MountMode.EXEC, shellParserFactory: () => Promise.resolve(parser) },
    )
    try {
      await ws.execute('echo moved-bytes > /a/x.txt')
      await ws.dispatch('rename', '/a/x.txt', [PathSpec.fromStrPath('/b/y.txt')])
      // Both languages execute the rename on the source backend; the dst
      // key is the virtual path minus the source prefix, so the file
      // stays on /a under b/y.txt. Neither language crosses mounts.
      expect(DEC.decode((await ws.execute('cat /a/b/y.txt')).stdout)).toBe('moved-bytes\n')
      expect((await ws.execute('cat /a/x.txt')).exitCode).not.toBe(0)
      expect((await ws.execute('cat /b/y.txt')).exitCode).not.toBe(0)
    } finally {
      await ws.close()
    }
  }, 30_000)
})
