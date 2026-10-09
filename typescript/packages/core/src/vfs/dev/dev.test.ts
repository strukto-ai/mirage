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

import { Mount } from '../../workspace/mount/spec.ts'
import { CLISpec } from '../../commands/cli/types.ts'
import { runWithSession } from '../../context/session_context.ts'
import { SessionState } from '../../workspace/session/session.ts'
import { IOResult } from '../../io/types.ts'
import { describe, expect, it } from 'vitest'
import { ops } from '../../test-utils.ts'
import { MountMode, PathSpec, VFSName } from '../../types.ts'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { RAMVFS } from '../ram/ram.ts'
import { DevVFS } from './dev.ts'

function setupOps(): { dev: DevVFS } {
  return { dev: new DevVFS() }
}

function call(name: string, dev: DevVFS, path: string, ...args: unknown[]): Promise<unknown> {
  return ops(dev).call(name, PathSpec.fromStrPath(path), args)
}

async function makeWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const data = new RAMVFS()
  return new Workspace({ '/data': data }, { mode: MountMode.WRITE, shellParser: parser })
}

describe('DevVFS', () => {
  it('reports kind = ram (matching Python parity)', () => {
    expect(new DevVFS().name).toBe(VFSName.RAM)
  })

  it('exposes the same op surface as RAMVFS', () => {
    const table = ops(new DevVFS())
    for (const name of ['read', 'write', 'readdir', 'stat']) expect(table.has(name)).toBe(true)
  })

  it('reads /null as empty bytes', async () => {
    const { dev } = setupOps()
    const data = (await call('read', dev, '/null')) as Uint8Array
    expect(data.byteLength).toBe(0)
  })

  it('refuses to materialize all of /zero', async () => {
    const { dev } = setupOps()
    await expect(call('read', dev, '/zero')).rejects.toMatchObject({ code: 'EINVAL' })
  })

  it('writes are silently discarded', async () => {
    const { dev } = setupOps()
    await call('write', dev, '/null', new TextEncoder().encode('ignored'))
    const after = (await call('read', dev, '/null')) as Uint8Array
    expect(after.byteLength).toBe(0)
  })

  it('reads of unknown paths throw file-not-found', async () => {
    const { dev } = setupOps()
    await expect(call('read', dev, '/nope')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('readdir of root lists /null and /zero', async () => {
    const { dev } = setupOps()
    const entries = (await call('readdir', dev, '/')) as string[]
    expect(entries.sort()).toEqual(['/null', '/zero'])
  })
})

describe('character device commands', () => {
  it('serves ranged zero reads beyond the old finite buffer', async () => {
    const ws = await makeWs()
    const result = await ws.shell('head -c 2M /dev/zero | wc -c')
    expect(result.stdoutText).toBe('2097152\n')
    await ws.close()
  })

  it('bounds an unqualified cat without changing its successful status', async () => {
    const ws = await makeWs()
    const result = await ws.shell('cat /dev/zero')
    expect(result.exitCode).toBe(0)
    expect(result.stdout.byteLength).toBe(8 << 20)
    expect(result.stdout.every((byte) => byte === 0)).toBe(true)
    expect(result.stderrText).toContain('output truncated')
    await ws.close()
  })

  it('bounds default head without buffering an endless unterminated line', async () => {
    const ws = await makeWs()
    const result = await ws.shell('head /dev/zero')
    expect(result.exitCode).toBe(0)
    expect(result.stdout.byteLength).toBe(8 << 20)
    expect(result.stdout.every((byte) => byte === 0)).toBe(true)
    expect(result.stderrText).toContain('output truncated')
    await ws.close()
  })

  it('does not apply the device safeguard to adjacent regular files', async () => {
    const ws = await makeWs()
    const size = (8 << 20) + 1
    await ws.vfs.write('/data/large.bin', new Uint8Array(size))
    const result = await ws.shell('cat /dev/null /data/large.bin | wc -c')
    expect(result.exitCode).toBe(0)
    expect(result.stdoutText).toBe(`${String(size)}\n`)
    expect(result.stderrText).not.toContain('output truncated')
    await ws.close()
  })

  it('classifies and renders active synthetic devices', async () => {
    const ws = await makeWs()
    expect((await ws.shell('find /dev -type f')).stdoutText).toBe('')
    expect((await ws.shell('find /dev -type c')).stdoutText).toBe('/dev/null\n/dev/zero\n')
    expect((await ws.shell('find /dev -empty')).stdoutText).toBe('')
    expect((await ws.shell("stat -c '%F %t %T' /dev/null")).stdoutText).toBe(
      'character special file 1 3\n',
    )
    const longZero = (await ws.shell('ls -l /dev/zero')).stdoutText
    expect(longZero).toMatch(/^crw-rw-rw-/)
    expect(longZero).toContain('1, 5')
    expect((await ws.shell('file /dev/zero')).stdoutText).toBe(
      '/dev/zero: character special (1/5)\n',
    )
    expect((await ws.shell('du /dev/zero')).stdoutText).toBe('0\t/dev/zero\n')
    expect((await ws.shell("find /dev/null -printf '%m %M\\n'")).stdoutText).toBe(
      '666 crw-rw-rw-\n',
    )
    expect((await ws.shell("stat -c '%a %f' /dev/null")).stdoutText).toBe('666 21b6\n')
    await ws.close()
  })

  it('answers regular-file and size predicates by kind', async () => {
    const ws = await makeWs()
    expect((await ws.shell('test -f /dev/null; echo $?')).stdoutText).toBe('1\n')
    expect((await ws.shell('test -c /dev/null; echo $?')).stdoutText).toBe('0\n')
    expect((await ws.shell('test -s /dev/zero; echo $?')).stdoutText).toBe('1\n')
    await ws.close()
  })

  it('refuses commands that require a whole read of an endless device', async () => {
    const ws = await makeWs()
    const commands = [
      'cp /dev/zero /data/out',
      'source /dev/zero',
      'md5 /dev/zero',
      'grep needle /dev/zero',
      'rg needle /dev/zero',
    ]
    for (const command of commands) {
      const result = await ws.shell(command)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderrText).toContain('cannot read an endless device without a size')
    }
    await ws.close()
  })
})

describe('dev file removal (GNU rm /dev/null semantics)', () => {
  it('rm /dev/null exits 0 and the path is gone', async () => {
    const ws = await makeWs()
    const rm = await ws.shell('rm /dev/null')
    expect(rm.exitCode).toBe(0)
    expect(rm.stdoutText).toBe('')
    expect(new TextDecoder().decode(rm.stderr)).toBe('')
    const ls = await ws.shell('ls /dev')
    expect(ls.stdoutText.split('\n')).toContain('zero')
    expect(ls.stdoutText.split('\n')).not.toContain('null')
    const cat = await ws.shell('cat /dev/null')
    expect(cat.exitCode).not.toBe(0)
    expect(new TextDecoder().decode(cat.stderr)).toMatch(/No such file or directory/)
    await ws.close()
  })

  it('rm -v /dev/null prints a true removed claim', async () => {
    const ws = await makeWs()
    const rm = await ws.shell('rm -v /dev/null')
    expect(rm.exitCode).toBe(0)
    expect(rm.stdoutText).toBe("removed '/dev/null'\n")
    const ls = await ws.shell('ls /dev')
    expect(ls.stdoutText.split('\n')).not.toContain('null')
    await ws.close()
  })

  it('rm -rf /dev/null removes the file too', async () => {
    const ws = await makeWs()
    const rm = await ws.shell('rm -rf /dev/null')
    expect(rm.exitCode).toBe(0)
    const ls = await ws.shell('ls /dev')
    expect(ls.stdoutText.split('\n')).not.toContain('null')
    await ws.close()
  })

  it('a redirect recreates a removed /dev/null as a regular file', async () => {
    const ws = await makeWs()
    await ws.shell('rm /dev/null')
    const write = await ws.shell('echo recreated > /dev/null')
    expect(write.exitCode).toBe(0)
    const cat = await ws.shell('cat /dev/null')
    expect(cat.stdoutText).toBe('recreated\n')
    const test = await ws.shell('if [ -f /dev/null ]; then echo regular; fi')
    expect(test.stdoutText).toBe('regular\n')
    await ws.close()
  })

  it('rm /dev/zero is symmetric', async () => {
    const ws = await makeWs()
    const rm = await ws.shell('rm /dev/zero')
    expect(rm.exitCode).toBe(0)
    const ls = await ws.shell('ls /dev')
    expect(ls.stdoutText.split('\n')).toContain('null')
    expect(ls.stdoutText.split('\n')).not.toContain('zero')
    const write = await ws.shell('echo z > /dev/zero')
    expect(write.exitCode).toBe(0)
    const cat = await ws.shell('cat /dev/zero')
    expect(cat.stdoutText).toBe('z\n')
    await ws.close()
  })
})

describe('DevVFS auto-mount in Workspace', () => {
  it('Workspace auto-mounts /dev/ without the user having to declare it', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    const [resolved] = await ws.resolve('/dev/null')
    expect(resolved.name).toBe(VFSName.RAM)
    await ws.close()
  })

  it('declaring /dev/ explicitly raises duplicate-mount (matches Python)', () => {
    expect(() => new Workspace({ '/dev': new DevVFS() }, { mode: MountMode.WRITE })).toThrow(
      /duplicate mount prefix/,
    )
  })
})

it('keeps process substitution private while another session runs', async () => {
  let readyResolve!: () => void
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve
  })
  let releaseResolve!: () => void
  const release = new Promise<void>((resolve) => {
    releaseResolve = resolve
  })
  const ws = await makeWs()
  ws.createSession('owner')
  ws.createSession('peer')
  ws.registerCli(
    'hold',
    new CLISpec({
      name: 'hold',
      fn: async () => {
        readyResolve()
        await release
        return [null, new IOResult()]
      },
    }),
  )
  const owner = ws.shell(
    'consume() { ls /dev/fd >/dev/null; hold; cat "$1"; }; consume <(echo private)',
    { sessionId: 'owner' },
  )
  try {
    await ready
    for (const command of [
      'cat /dev/fd/63',
      'stat /dev/fd/63',
      'ls /dev/fd',
      'echo corrupt > /dev/fd/63',
      'rm /dev/fd/63',
      'mkdir -p /dev/fd/63',
      'mv /dev/fd /dev/stolen',
    ]) {
      const result = await ws.shell(command, { sessionId: 'peer' })
      expect(result.exitCode, command).not.toBe(0)
      expect(new TextDecoder().decode(result.stdout)).not.toContain('private')
    }
    expect(
      new TextDecoder().decode((await ws.shell('cat <(echo peer)', { sessionId: 'peer' })).stdout),
    ).toBe('peer\n')
    releaseResolve()
    const result = await owner
    expect(result.exitCode).toBe(0)
    expect(new TextDecoder().decode(result.stdout)).toBe('private\n')
    expect(
      new TextDecoder().decode((await ws.shell('ls /dev', { sessionId: 'owner' })).stdout),
    ).not.toContain('fd')
  } finally {
    releaseResolve()
    await owner
    await ws.close()
  }
})

it('preserves a reused descriptor when an earlier substitution finishes', async () => {
  let oldReadyResolve!: () => void
  const oldReady = new Promise<void>((resolve) => {
    oldReadyResolve = resolve
  })
  let oldReleaseResolve!: () => void
  const oldRelease = new Promise<void>((resolve) => {
    oldReleaseResolve = resolve
  })
  let newReadyResolve!: () => void
  const newReady = new Promise<void>((resolve) => {
    newReadyResolve = resolve
  })
  let newReleaseResolve!: () => void
  const newRelease = new Promise<void>((resolve) => {
    newReleaseResolve = resolve
  })
  const ws = await makeWs()
  ws.createSession('owner')
  ws.createSession('peer')
  ws.registerCli(
    'hold-old',
    new CLISpec({
      name: 'hold-old',
      fn: async () => {
        oldReadyResolve()
        await oldRelease
        return [null, new IOResult()]
      },
    }),
  )
  ws.registerCli(
    'hold-new',
    new CLISpec({
      name: 'hold-new',
      fn: async () => {
        newReadyResolve()
        await newRelease
        return [null, new IOResult()]
      },
    }),
  )
  const owner = ws.shell('consume() { echo "$1"; rm "$1"; hold-old; }; consume <(echo old)', {
    sessionId: 'owner',
  })
  let peer: typeof owner | undefined
  try {
    await oldReady
    peer = ws.shell('consume() { echo "$1"; hold-new; cat "$1"; }; consume <(echo new)', {
      sessionId: 'peer',
    })
    await newReady
    oldReleaseResolve()
    const oldResult = await owner
    expect(oldResult.exitCode).toBe(0)
    expect(oldResult.stdoutText).toBe('/dev/fd/63\n')
    newReleaseResolve()
    const newResult = await peer
    expect(newResult.exitCode).toBe(0)
    expect(newResult.stdoutText).toBe('/dev/fd/63\nnew\n')
    expect((await ws.shell('ls /dev/fd', { sessionId: 'peer' })).exitCode).not.toBe(0)
  } finally {
    oldReleaseResolve()
    newReleaseResolve()
    await owner
    await peer
    await ws.close()
  }
})

it('rejects stale writes and releases after the same session reuses an input', async () => {
  const dev = new DevVFS()
  await runWithSession(new SessionState({ sessionId: 'owner' }), () => {
    const [path, oldAllocation] = dev.allocateInput()
    dev.store.files.delete(path.slice(4))
    const [newPath, newAllocation] = dev.allocateInput()
    expect(newPath).toBe(path)
    const data = new TextEncoder().encode('new')
    dev.setInput(newPath, newAllocation, data)
    dev.store.modified.set(path.slice(4), '2026-09-23T00:00:00Z')
    dev.store.attrs.set(path.slice(4), { mode: 0o600 })
    expect(() => {
      dev.setInput(path, oldAllocation, new Uint8Array())
    }).toThrow()
    dev.releaseInput(path, oldAllocation)
    expect(dev.store.files.get(path.slice(4))).toEqual(data)
    expect(dev.store.modified.get(path.slice(4))).toBe('2026-09-23T00:00:00Z')
    expect(dev.store.attrs.get(path.slice(4))).toEqual({ mode: 0o600 })
    dev.releaseInput(newPath, newAllocation)
    dev.releaseInput(newPath, newAllocation)
    expect(dev.store.files.has(path.slice(4))).toBe(false)
    expect(dev.store.modified.has(path.slice(4))).toBe(false)
    expect(dev.store.attrs.has(path.slice(4))).toBe(false)
    return Promise.resolve()
  })
})

it.each([false, true])(
  'keeps alternate device mounts session-private (configured: %s)',
  async (configured) => {
    const dev = new DevVFS()
    const ws = new Workspace(
      { '/devices': configured ? new Mount(dev, { index: { ttl: 120 } }) : dev },
      { index: { ttl: 600 }, shellParser: await getTestParser() },
    )
    const owner = ws.createSession('owner')
    ws.createSession('peer')
    await runWithSession(owner, () => {
      const [path, allocation] = dev.allocateInput()
      dev.setInput(path, allocation, new TextEncoder().encode('private'))
      return Promise.resolve()
    })
    try {
      const listed = await ws.shell('ls /devices/fd', { sessionId: 'owner' })
      expect(listed.exitCode).toBe(0)
      expect(listed.stdoutText).toBe('63\n')
      const peer = await ws.shell('ls /devices/fd', { sessionId: 'peer' })
      expect(peer.stdoutText).not.toContain('63')
      expect(peer.exitCode).not.toBe(0)
    } finally {
      await ws.close()
    }
  },
)
