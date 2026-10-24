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

import { beforeEach, describe, expect, it } from 'vitest'
import { commandsFor } from '@struktoai/mirage-core/workspace/mount/backends'
import { PathSpec, VFSName } from '@struktoai/mirage-core/types'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { type FakeSftp, makeFakeAccessor } from '../../../tests/core/ssh/_test_utils.ts'
import type { SSHConfig } from './config.ts'
import { SSHVFS } from './ssh.ts'

function makeVfs(state: FakeSftp, config?: Partial<SSHConfig>): SSHVFS {
  const cfg: SSHConfig = {
    host: 'example.com',
    username: 'alice',
    password: 'secret',
    passphrase: 'phrase',
    ...config,
  }
  const fake = makeFakeAccessor(state, cfg.root ?? '/')
  const vfs = new SSHVFS(cfg)
  ;(vfs as { accessor: SSHAccessor }).accessor = fake
  return vfs
}

let state: FakeSftp

beforeEach(() => {
  state = { files: new Map(), dirs: new Map([['/', {}]]) }
})

describe('SSHVFS — identity', () => {
  it('exposes kind = ssh and cachesReads = true', () => {
    const res = makeVfs(state)
    expect(res.name).toBe(VFSName.SSH)
    expect(res.cachesReads).toBe(true)
  })

  it('describes no layout of its own', () => {
    expect(makeVfs(state).vfsMd).toBe('')
  })

  it('serves no commands of its own', () => {
    expect(commandsFor(makeVfs(state))).toEqual([])
  })
})

describe('SSHVFS — getState / loadState', () => {
  it('redacts password and passphrase', async () => {
    const res = makeVfs(state)
    const result = await res.getState()
    expect(result.type).toBe(VFSName.SSH)
    expect(result).not.toHaveProperty('needsOverride')
    expect(result).not.toHaveProperty('redactedFields')
    expect(result.config.password).toBe('<REDACTED>')
    expect(result.config.passphrase).toBe('<REDACTED>')
    expect(result.config.host).toBe('example.com')
    expect(result.config.username).toBe('alice')
  })

  it('loadState is a no-op', async () => {
    const res = makeVfs(state)
    const result = await res.getState()
    await res.loadState(result)
    expect(await res.getState()).toEqual(result)
  })
})

const location = (username: string, root: string): string =>
  new SSHVFS({ host: 'box', username, root }).storageLocation()

// Twin of test_two_logins_to_one_root_are_one_store and
// test_a_relative_root_is_each_logins_own.
describe('SSHVFS storageLocation', () => {
  it('is one store for two logins to one root', () => {
    expect(location('ada', '/srv/data')).toBe(location('bob', '/srv/data/'))
    expect(location('ada', '/srv/data')).not.toBe(location('ada', '/srv'))
  })

  it("is each login's own under a relative root", () => {
    expect(location('ada', 'data')).not.toBe(location('bob', 'data'))
    expect(location('ada', 'data')).toBe(location('ada', 'data/'))
  })
})

describe('SSHVFS write', () => {
  // The mount asks for an atomic write of bytes as it does of a stream, and
  // either is staged and renamed into place whole.
  it('stages an atomic write of bytes', async () => {
    state.dirs.set('/data', {})
    state.files.set('/data/a', { data: new TextEncoder().encode('old'), attrs: { mode: 0o100640 } })
    const vfs = makeVfs(state)
    const sftp = await vfs.accessor.sftp()
    const renamed: string[] = []
    const rename = sftp.rename.bind(sftp)
    sftp.ext_openssh_rename = (src: string, dst: string, cb: (err?: Error | null) => void) => {
      renamed.push(dst)
      rename(src, dst, cb)
    }
    await vfs.write(
      PathSpec.fromStrPath('/data/a'),
      new TextEncoder().encode('new'),
      undefined,
      {},
      true,
    )
    expect(renamed).toEqual(['/data/a'])
    expect(new TextDecoder().decode(state.files.get('/data/a')?.data)).toBe('new')
  })
})
