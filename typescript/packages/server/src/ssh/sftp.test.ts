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

import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MountMode } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Workspace } from '@struktoai/mirage-node'
import ssh2, { type Client, type FileEntryWithStats, type SFTPWrapper, type Stats } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceRegistry, type WorkspaceEntry } from '../registry.ts'
import { mintKeyPair } from './keys.ts'
import { startSSHServer } from './server.ts'
import { STATUS, longname, toAttrs, workspacePath } from './sftp.ts'
import type { SSHListener } from './types.ts'

interface Harness {
  registry: WorkspaceRegistry
  entry: WorkspaceEntry
  listener: SSHListener
  privateKey: string
  keysFile: string
}

const open: Harness[] = []
const clients: Client[] = []
const PAYLOAD = Buffer.from(Array.from({ length: 256 * 300 }, (_, i) => i % 256))
// SSH_FXP_INIT asking for version 3: length 5, type 1, version 3.
const FXP_INIT_V3 = Buffer.from([0, 0, 0, 5, 1, 0, 0, 0, 3])
const FXP_VERSION = 2

async function startHarness(mode: MountMode = MountMode.WRITE, ws?: Workspace): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'mirage-ssh-sftp-'))
  const pair = mintKeyPair(ssh2.utils)
  writeFileSync(join(dir, 'authorized_keys'), `${pair.public}\n`)
  const registry = new WorkspaceRegistry({ idleGraceSeconds: 0 })
  const entry = registry.add(ws ?? new Workspace({ '/': new RAMVFS() }, { mode }), 'demo')
  const listener = await startSSHServer(registry, {
    port: 0,
    host: '127.0.0.1',
    hostKeyFile: join(dir, 'host_key'),
    authorizedKeysFile: join(dir, 'authorized_keys'),
  })
  const harness = {
    registry,
    entry,
    listener,
    privateKey: pair.private,
    keysFile: join(dir, 'authorized_keys'),
  }
  open.push(harness)
  return harness
}

function connect(h: Harness, username = 'demo', privateKey = h.privateKey): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client()
    clients.push(client)
    client.on('ready', () => {
      resolve(client)
    })
    client.on('error', reject)
    client.connect({ host: '127.0.0.1', port: h.listener.port, username, privateKey })
  })
}

/** Authorize a fresh client key whose line carries `options`. */
function bindKey(h: Harness, options: string): string {
  const pair = mintKeyPair(ssh2.utils)
  appendFileSync(h.keysFile, `${options} ${pair.public}\n`)
  return pair.private
}

/** A workspace whose `guarded` profile seals `/vault`. */
async function vaultWorkspace(): Promise<Workspace> {
  const ws = new Workspace(
    { '/': new RAMVFS() },
    {
      mode: MountMode.WRITE,
      profiles: {
        guarded: { commands: { deny: [{ reason: 'the vault is sealed', paths: ['/vault/*'] }] } },
      },
    },
  )
  await ws.shell('mkdir -p /vault && echo token > /vault/secret')
  return ws
}

function sftpOf(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err !== undefined) reject(err)
      else resolve(sftp)
    })
  })
}

function call<T>(fn: (cb: (err: Error | null | undefined, value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((err, value) => {
      if (err !== undefined && err !== null) reject(err)
      else resolve(value)
    })
  })
}

function done(fn: (cb: (err: Error | null | undefined) => void) => void): Promise<void> {
  return call<undefined>((cb) => {
    fn((err) => {
      cb(err, undefined)
    })
  })
}

function run(client: Client, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err !== undefined) {
        reject(err)
        return
      }
      let out = ''
      stream.on('data', (d: Buffer) => {
        out += d.toString()
      })
      stream.on('close', () => {
        resolve(out)
      })
    })
  })
}

function codeOf(err: unknown): number | undefined {
  return (err as { code?: number }).code
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.end()
  for (const h of open.splice(0)) {
    await h.listener.close()
    await h.registry.closeAll()
  }
})

describe('helpers', () => {
  it('normalize client paths without ever leaving /', () => {
    expect(workspacePath('.')).toBe('/')
    expect(workspacePath('/d/../d/./sub/')).toBe('/d/sub')
    expect(workspacePath('/../../etc')).toBe('/etc')
    expect(workspacePath('//abs')).toBe('/abs')
  })

  it('carry mode, size and whole-second times', () => {
    const when = new Date(1_700_000_001_500)
    const attrs = toAttrs({
      mtime: when,
      atime: when,
      ctime: when,
      nlink: 1,
      size: 12,
      mode: 0o100640,
      uid: 501,
      gid: 20,
      rdev: 0,
    })
    expect(attrs).toEqual({
      mode: 0o100640,
      uid: 501,
      gid: 20,
      size: 12,
      atime: 1_700_000_001,
      mtime: 1_700_000_001,
    })
    expect(longname('f', attrs).startsWith('-rw-r-----')).toBe(true)
    expect(longname('f', attrs).endsWith(' f')).toBe(true)
  })
})

describe('sftp', () => {
  it('round-trips binary content', async () => {
    const sftp = await sftpOf(await connect(await startHarness()))
    await done((cb) => {
      sftp.writeFile('/blob.bin', PAYLOAD, cb)
    })
    const back = await call<Buffer>((cb) => {
      sftp.readFile('/blob.bin', cb)
    })
    expect(back.equals(PAYLOAD)).toBe(true)
    const st = await call<Stats>((cb) => {
      sftp.stat('/blob.bin', cb)
    })
    expect(st.size).toBe(PAYLOAD.byteLength)
  })

  it('shares one tree with the shell', async () => {
    const client = await connect(await startHarness())
    await run(client, 'mkdir -p /work && echo from-shell > /work/a.txt')
    const sftp = await sftpOf(client)
    const a = await call<Buffer>((cb) => {
      sftp.readFile('/work/a.txt', cb)
    })
    expect(a.toString()).toBe('from-shell\n')
    await done((cb) => {
      sftp.writeFile('/work/b.txt', 'from-sftp\n', cb)
    })
    expect(await run(client, 'cat /work/b.txt')).toBe('from-sftp\n')
  })

  it('lists, stats and resolves paths', async () => {
    const client = await connect(await startHarness())
    await run(client, 'mkdir -p /d/sub && echo x > /d/f')
    const sftp = await sftpOf(client)
    expect(
      await call<string>((cb) => {
        sftp.realpath('.', cb)
      }),
    ).toBe('/')
    const names = (
      await call<FileEntryWithStats[]>((cb) => {
        sftp.readdir('/d', cb)
      })
    ).map((e) => e.filename)
    expect(names.filter((n) => n !== '.' && n !== '..').sort()).toEqual(['f', 'sub'])
    expect(
      (
        await call<Stats>((cb) => {
          sftp.stat('/d/sub', cb)
        })
      ).isDirectory(),
    ).toBe(true)
    await expect(
      call<Stats>((cb) => {
        sftp.stat('/d/missing', cb)
      }),
    ).rejects.toSatisfy((err) => codeOf(err) === STATUS.NO_SUCH_FILE)
  })

  it('never reaches the host filesystem', async () => {
    const sftp = await sftpOf(await connect(await startHarness()))
    await expect(
      call<Stats>((cb) => {
        sftp.stat('/etc/passwd', cb)
      }),
    ).rejects.toSatisfy((err) => codeOf(err) === STATUS.NO_SUCH_FILE)
  })

  it('makes, renames and removes', async () => {
    const sftp = await sftpOf(await connect(await startHarness()))
    await done((cb) => {
      sftp.mkdir('/box', cb)
    })
    await done((cb) => {
      sftp.writeFile('/box/one', '1', cb)
    })
    await done((cb) => {
      sftp.rename('/box/one', '/box/two', cb)
    })
    const names = (
      await call<FileEntryWithStats[]>((cb) => {
        sftp.readdir('/box', cb)
      })
    ).map((e) => e.filename)
    expect(names.filter((n) => n !== '.' && n !== '..')).toEqual(['two'])
    await done((cb) => {
      sftp.unlink('/box/two', cb)
    })
    await done((cb) => {
      sftp.rmdir('/box', cb)
    })
    await expect(
      call<Stats>((cb) => {
        sftp.stat('/box', cb)
      }),
    ).rejects.toBeDefined()
  })

  it('refuses a v3 rename onto an existing target', async () => {
    const sftp = await sftpOf(await connect(await startHarness()))
    for (const name of ['/a', '/b']) {
      await done((cb) => {
        sftp.writeFile(name, name, cb)
      })
    }
    await expect(
      done((cb) => {
        sftp.rename('/a', '/b', cb)
      }),
    ).rejects.toSatisfy((err) => codeOf(err) === STATUS.FAILURE)
  })

  it('refuses an exclusive create of an existing file', async () => {
    const sftp = await sftpOf(await connect(await startHarness()))
    await done((cb) => {
      sftp.writeFile('/x', 'x', cb)
    })
    await expect(
      call((cb) => {
        sftp.open('/x', 'wx', cb)
      }),
    ).rejects.toBeDefined()
  })

  it('appends at the end', async () => {
    const sftp = await sftpOf(await connect(await startHarness()))
    await done((cb) => {
      sftp.writeFile('/log', 'one\n', cb)
    })
    await done((cb) => {
      sftp.appendFile('/log', 'two\n', cb)
    })
    expect(
      (
        await call<Buffer>((cb) => {
          sftp.readFile('/log', cb)
        })
      ).toString(),
    ).toBe('one\ntwo\n')
  })

  it('truncates on a setstat size', async () => {
    const sftp = await sftpOf(await connect(await startHarness()))
    await done((cb) => {
      sftp.writeFile('/t', 'abcdef', cb)
    })
    await done((cb) => {
      sftp.setstat('/t', { size: 3 }, cb)
    })
    expect(
      (
        await call<Buffer>((cb) => {
          sftp.readFile('/t', cb)
        })
      ).toString(),
    ).toBe('abc')
  })

  it('stores the permissions, owner and times a setstat sends', async () => {
    // sftp chmod, chown and `put -p`'s times land where a shell stat reads.
    const client = await connect(await startHarness())
    const sftp = await sftpOf(client)
    await done((cb) => {
      sftp.writeFile('/f', 'x', cb)
    })
    await done((cb) => {
      sftp.setstat('/f', { mode: 0o640, uid: 1234, gid: 5678 }, cb)
    })
    await done((cb) => {
      sftp.setstat('/f', { atime: 1_000_000_000, mtime: 1_100_000_000 }, cb)
    })
    expect(await run(client, "stat -c '%a %u %g %X %Y' /f")).toBe(
      '640 1234 5678 1000000000 1100000000\n',
    )
  })

  it('follows a link on a setstat, as chown(2) and utimes(2) do', async () => {
    const client = await connect(await startHarness())
    await run(client, 'echo target > /real; ln -s real /link')
    const sftp = await sftpOf(client)
    await done((cb) => {
      sftp.setstat('/link', { uid: 1234, gid: 5678, atime: 1e9, mtime: 1.1e9 }, cb)
    })
    expect(await run(client, "stat -c '%u %Y' /real; stat -c %u /link")).toBe(
      '1234 1100000000\n-\n',
    )
  })

  it('keeps the permissions an open and a mkdir create with', async () => {
    const client = await connect(await startHarness())
    const sftp = await sftpOf(client)
    const handle = await call<Buffer>((cb) => {
      sftp.open('/secret', 'w', { mode: 0o600 }, cb)
    })
    await done((cb) => {
      sftp.close(handle, cb)
    })
    await done((cb) => {
      sftp.mkdir('/private', { mode: 0o700 }, cb)
    })
    expect(await run(client, "stat -c '%a %n' /secret /private")).toBe(
      '600 /secret\n700 /private\n',
    )
  })

  it('round-trips a symlink', async () => {
    const client = await connect(await startHarness())
    await run(client, 'echo target > /real')
    const sftp = await sftpOf(client)
    await done((cb) => {
      sftp.symlink('/real', '/link', cb)
    })
    expect(
      await call<string>((cb) => {
        sftp.readlink('/link', cb)
      }),
    ).toBe('real')
    expect(
      (
        await call<Stats>((cb) => {
          sftp.lstat('/link', cb)
        })
      ).isSymbolicLink(),
    ).toBe(true)
    expect(
      (
        await call<Stats>((cb) => {
          sftp.stat('/link', cb)
        })
      ).isFile(),
    ).toBe(true)
  })

  it('refuses writes on a read-only mount', async () => {
    const sftp = await sftpOf(await connect(await startHarness(MountMode.READ)))
    await expect(
      done((cb) => {
        sftp.writeFile('/nope', 'x', cb)
      }),
    ).rejects.toSatisfy((err) => codeOf(err) === STATUS.PERMISSION_DENIED)
  })

  it('serves nothing for an unknown workspace', async () => {
    const sftp = await sftpOf(await connect(await startHarness(), 'nope'))
    await expect(
      call<Stats>((cb) => {
        sftp.stat('/', cb)
      }),
    ).rejects.toSatisfy((err) => codeOf(err) === STATUS.NO_SUCH_FILE)
  })

  it('exits the channel with status 0', async () => {
    // OpenSSH's scp (in SFTP mode) fails a copy whose ssh exits non-zero,
    // and ssh exits 255 for a channel that closes with no exit status.
    const client = await connect(await startHarness())
    const code = await new Promise<number | null>((resolve, reject) => {
      client.subsys('sftp', (err, stream) => {
        if (err !== undefined) {
          reject(err)
          return
        }
        let exit: number | null = null
        stream.on('exit', (c: number | null) => {
          exit = c
        })
        stream.on('close', () => {
          resolve(exit)
        })
        stream.once('data', (d: Buffer) => {
          expect(d[4]).toBe(FXP_VERSION)
          stream.end()
        })
        stream.write(FXP_INIT_V3)
      })
    })
    expect(code).toBe(0)
  })

  it('closes its session when the client leaves', async () => {
    const h = await startHarness()
    const client = await connect(h)
    const sftp = await sftpOf(client)
    await call<Stats>((cb) => {
      sftp.stat('/', cb)
    })
    sftp.end()
    await new Promise((r) => setTimeout(r, 200))
    const ids = h.entry.runner.ws.listSessions().map((s) => s.sessionId)
    expect(ids.filter((id) => id.startsWith('ssh_'))).toEqual([])
  })
})

describe('open files across rename', () => {
  it.each([false, true])(
    'retains writes and handle operations (directory=%s)',
    async (directory) => {
      const sftp = await sftpOf(await connect(await startHarness()))
      await done((cb) => {
        sftp.mkdir('/old', cb)
      })
      const handle = await call<Buffer>((cb) => {
        sftp.open('/old/file', 'w+', cb)
      })
      const before = Buffer.from('before')
      await done((cb) => {
        sftp.write(handle, before, 0, before.length, 0, cb)
      })
      await done((cb) => {
        sftp.rename(directory ? '/old' : '/old/file', '/new', cb)
      })
      const after = Buffer.from('after')
      await done((cb) => {
        sftp.write(handle, after, 0, after.length, 6, cb)
      })
      await done((cb) => {
        sftp.fsetstat(handle, { size: 9 }, cb)
      })
      expect(
        (
          await call<Stats>((cb) => {
            sftp.fstat(handle, cb)
          })
        ).size,
      ).toBe(9)
      await done((cb) => {
        sftp.close(handle, cb)
      })
      const content = await call<Buffer>((cb) => {
        sftp.readFile(directory ? '/new/file' : '/new', cb)
      })
      expect(content.toString()).toBe('beforeaft')
      await expect(
        call<Stats>((cb) => {
          sftp.stat('/old/file', cb)
        }),
      ).rejects.toMatchObject({
        code: STATUS.NO_SUCH_FILE,
      })
    },
  )
})

it('keeps the open file when rename is refused', async () => {
  const sftp = await sftpOf(await connect(await startHarness()))
  await done((cb) => {
    sftp.writeFile('/taken', 'untouched', cb)
  })
  const handle = await call<Buffer>((cb) => {
    sftp.open('/source', 'w', cb)
  })
  await expect(
    done((cb) => {
      sftp.rename('/source', '/taken', cb)
    }),
  ).rejects.toThrow()
  const data = Buffer.from('retained')
  await done((cb) => {
    sftp.write(handle, data, 0, data.length, 0, cb)
  })
  await done((cb) => {
    sftp.close(handle, cb)
  })
  expect(
    (
      await call<Buffer>((cb) => {
        sftp.readFile('/source', cb)
      })
    ).toString(),
  ).toBe('retained')
  expect(
    (
      await call<Buffer>((cb) => {
        sftp.readFile('/taken', cb)
      })
    ).toString(),
  ).toBe('untouched')
})

it('serves a key bound to a profile under it', async () => {
  const h = await startHarness(MountMode.WRITE, await vaultWorkspace())
  const guarded = bindKey(h, 'mirage-profile="guarded"')
  const unsealed = await sftpOf(await connect(h))
  const content = await call<Buffer>((cb) => {
    unsealed.readFile('/vault/secret', cb)
  })
  expect(content.toString()).toBe('token\n')
  const sealed = await sftpOf(await connect(h, 'demo', guarded))
  await expect(
    call<Buffer>((cb) => {
      sealed.readFile('/vault/secret', cb)
    }),
  ).rejects.toMatchObject({ code: STATUS.PERMISSION_DENIED })
})

it('does not follow a hidden link on a stat', async () => {
  const ws = new Workspace(
    { '/': new RAMVFS() },
    { mode: MountMode.WRITE, profiles: { hiding: { paths: { hide: ['/lnk'] } } } },
  )
  await ws.shell('echo body > /a.txt && ln -s /a.txt /lnk')
  const h = await startHarness(MountMode.WRITE, ws)
  const hiding = bindKey(h, 'mirage-profile="hiding"')
  const open = await sftpOf(await connect(h))
  const st = await call<Stats>((cb) => {
    open.stat('/lnk', cb)
  })
  expect(st.size).toBe('body\n'.length)
  const hidden = await sftpOf(await connect(h, 'demo', hiding))
  await expect(
    call<Stats>((cb) => {
      hidden.stat('/lnk', cb)
    }),
  ).rejects.toMatchObject({ code: STATUS.NO_SUCH_FILE })
})
