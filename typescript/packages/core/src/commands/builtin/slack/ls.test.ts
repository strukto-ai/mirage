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
import { RAMIndexCacheStore } from '../../../cache/index/ram.ts'
import { materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { FakeSlackTransport, makeFakeResource, seedChannel, seedUser } from './_test_util.ts'
import { SLACK_COMMANDS } from './index.ts'

const SLACK_LS = SLACK_COMMANDS.filter((c) => c.name === 'ls' && c.filetype == null)

const DEC = new TextDecoder()

async function runLs(
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]>,
  options: {
    index?: RAMIndexCacheStore
    transport?: FakeSlackTransport
    cwd?: string
    mountPrefix?: string
  } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cmd = SLACK_LS[0]
  if (cmd === undefined) throw new Error('ls not registered')
  const transport = options.transport ?? new FakeSlackTransport()
  const resource = makeFakeResource(transport)
  const result = await cmd.fn(resource.accessor, paths, [], {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: options.cwd ?? '/',
    resource,
    ...(options.mountPrefix !== undefined ? { mountPrefix: options.mountPrefix } : {}),
    ...(options.index !== undefined ? { index: options.index } : {}),
  })
  if (result === null) return { stdout: '', stderr: '', exitCode: 0 }
  const [out, io] = result
  const stdoutBytes =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  const stderrBytes = await io.materializeStderr()
  return {
    stdout: DEC.decode(stdoutBytes),
    stderr: DEC.decode(stderrBytes),
    exitCode: io.exitCode,
  }
}

describe('slack ls', () => {
  it('lists virtual root', async () => {
    const idx = new RAMIndexCacheStore()
    const out = await runLs(
      [
        new PathSpec({
          original: '/mnt/slack',
          directory: '/mnt/slack',
          resolved: false,
          prefix: '/mnt/slack',
        }),
      ],
      {},
      { index: idx },
    )
    expect(out.stdout.trimEnd().split('\n').sort()).toEqual(['channels', 'dms', 'users'])
  })

  it('lists channel directory entries from cached index', async () => {
    const idx = new RAMIndexCacheStore()
    const transport = new FakeSlackTransport(() => {
      throw new Error('should not be called')
    })
    await seedChannel(idx, '/mnt/slack', 'general__C1', 'C1', { remoteTime: '0' })
    const out = await runLs(
      [
        new PathSpec({
          original: '/mnt/slack/channels',
          directory: '/mnt/slack/channels',
          resolved: false,
          prefix: '/mnt/slack',
        }),
      ],
      {},
      { index: idx, transport },
    )
    expect(out.stdout).toBe('general__C1\n')
    expect(transport.calls).toHaveLength(0)
  })

  it('lists user files', async () => {
    const idx = new RAMIndexCacheStore()
    const transport = new FakeSlackTransport(() => {
      throw new Error('should not be called')
    })
    await seedUser(idx, '/mnt/slack', 'alice__U1.json', 'U1')
    const out = await runLs(
      [
        new PathSpec({
          original: '/mnt/slack/users',
          directory: '/mnt/slack/users',
          resolved: false,
          prefix: '/mnt/slack',
        }),
      ],
      {},
      { index: idx, transport },
    )
    expect(out.stdout).toBe('alice__U1.json\n')
  })
})
