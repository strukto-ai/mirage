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

import { MountMode } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Session } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { ExecuteResult } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { Workspace } from '@struktoai/mirage-node'
import { describe, expect, it } from 'vitest'
import { CallArgsError, answered, checked, ioResultToDict } from './io_serde.ts'
import { VFS_CALL_BY_NAME, type VfsCall } from './vfs_calls.ts'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('ioResultToDict', () => {
  it('carries a null refusal on an ordinary run', () => {
    expect(ioResultToDict(new ExecuteResult(enc('hi\n'), enc(''), 0))).toEqual({
      kind: 'io',
      exit_code: 0,
      stdout: 'hi\n',
      stderr: '',
      refusal: null,
    })
  })

  it('serializes the refusal record beside the bash-voiced stderr', () => {
    const refused = new ExecuteResult(enc(''), enc('rm: Permission denied\n'), 126, {
      kind: 'pending',
      reason: 'sign-off',
      policy: '',
      scope: 'command',
      askId: 'abc123',
    })
    expect(ioResultToDict(refused)).toEqual({
      kind: 'io',
      exit_code: 126,
      stdout: '',
      stderr: 'rm: Permission denied\n',
      refusal: {
        kind: 'pending',
        reason: 'sign-off',
        policy: '',
        scope: 'command',
        ask_id: 'abc123',
      },
    })
  })
})

describe('checked and answered', () => {
  const byName = (name: string): VfsCall => {
    const call = VFS_CALL_BY_NAME.get(name)
    if (call === undefined) throw new Error(`no vfs call ${name}`)
    return call
  }

  it('runs or explains a VFS call as JSON', async () => {
    const ram = new RAMVFS()
    const ws = new Workspace({ '/': ram }, { mode: MountMode.WRITE })
    const session = new Session(ws, null)
    const args = await checked(byName('write'), { path: '/a', data_base64: 'aGk=' })
    expect(args).toEqual({ path: '/a', data: new Uint8Array([104, 105]) })
    expect(await answered(session, byName('write'), args, false)).toEqual({})
    expect(await answered(session, byName('read'), { path: '/a' }, false)).toEqual({
      data_base64: 'aGk=',
    })
    const said = await answered(session, byName('unlink'), { path: '/a' }, true)
    expect(said).toMatchObject({ call: 'unlink', outcome: 'allow' })
    expect(await session.vfs.exists('/a')).toBe(true)
    await ws.close()
  })

  it('refuses arguments outside the schema', async () => {
    await expect(checked(byName('write'), { path: '/a', data_base64: '%%' })).rejects.toThrow(
      new CallArgsError('data_base64 must be base64'),
    )
    await expect(checked(byName('write'), { path: '/a' })).rejects.toThrow(
      /invalid arguments for vfs\/write/,
    )
  })
})
