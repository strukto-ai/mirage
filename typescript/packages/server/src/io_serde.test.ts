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
import type { Policy } from '@struktoai/mirage-core/policy/base'
import type { Route } from '@struktoai/mirage-core/policy/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Session } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { ExecuteResult } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { Workspace } from '@struktoai/mirage-node'
import { describe, expect, it } from 'vitest'
import { CallArgsError, answered, checked, explanationToDict, ioResultToDict } from './io_serde.ts'
import { VFS_CALL_BY_NAME, type VfsCall } from './vfs_calls.ts'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

class OnMonty implements Policy {
  preExecute(): Promise<Route> {
    return Promise.resolve({ kind: 'route', runtime: 'monty', reason: 'plain arithmetic' })
  }
}

describe('ioResultToDict', () => {
  it('carries a null refusal on an ordinary run', () => {
    expect(ioResultToDict(new ExecuteResult(enc('hi\n'), enc(''), 0))).toEqual({
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
      askId: 'abc123',
    })
    expect(ioResultToDict(refused)).toEqual({
      exit_code: 126,
      stdout: '',
      stderr: 'rm: Permission denied\n',
      refusal: {
        kind: 'pending',
        reason: 'sign-off',
        policy: '',
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
    const args = await checked(byName('write'), { path: '/a', data: 'aGk=' })
    expect(args).toEqual({ path: '/a', data: new Uint8Array([104, 105]) })
    expect(await answered(session, byName('write'), args, false)).toBeNull()
    expect(await answered(session, byName('read'), { path: '/a' }, false)).toBe('aGk=')
    const said = await answered(session, byName('unlink'), { path: '/a' }, true)
    expect(said).toMatchObject({ call: 'unlink', outcome: 'allow' })
    expect(await session.vfs.exists('/a')).toBe(true)
    await ws.close()
  })

  it('carries the reason an explained route gives', async () => {
    const ws = new Workspace(
      { '/': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        runtimes: ['monty', 'workspace'],
        policies: [new OnMonty()],
      },
    )
    try {
      const said = explanationToDict(await ws.explain("python3 -c 'print(1)'"))
      expect(said.answers).toEqual([
        {
          kind: 'route',
          runtime: 'monty',
          machine: null,
          reason: 'plain arithmetic',
          policy: 'OnMonty',
        },
      ])
    } finally {
      await ws.close()
    }
  })

  it('refuses arguments outside the schema', async () => {
    await expect(checked(byName('write'), { path: '/a', data: '%%' })).rejects.toMatchObject({
      message: 'data must be base64',
      param: 'data',
    })
    await expect(checked(byName('write'), { path: '/a' })).rejects.toThrow(
      new CallArgsError("arguments do not fit vfs/write's schema"),
    )
  })
})
