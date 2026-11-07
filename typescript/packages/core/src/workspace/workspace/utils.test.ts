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

import { varsFromEnv } from '../../workspace/session/session.ts'
import { describe, expect, it } from 'vitest'

import { LOCAL_MACHINE } from '../../execution/constants.ts'
import type { Process } from '../../execution/process/types.ts'
import { ProcessId } from '../../execution/types.ts'
import { PathSpec } from '../../types.ts'
import { SessionState } from '../session/session.ts'
import { commandName, forkForCall, processTree } from './utils.ts'

describe('commandName', () => {
  it.each([
    ['ls -la /tmp', 'ls'],
    ['  ls  ', 'ls'],
    ['', ''],
    ['   ', ''],
    ['\tcat\tfile', 'cat'],
  ])('reads the leading word of %j', (line, expected) => {
    expect(commandName(line)).toBe(expected)
  })
})

function makeSession(): SessionState {
  return new SessionState({ sessionId: 's1', cwd: '/home', vars: varsFromEnv({ A: '1', B: '2' }) })
}

describe('forkForCall', () => {
  it('reuses the persistent session when no overrides are given', () => {
    const session = makeSession()
    expect(forkForCall(session, undefined, undefined)).toBe(session)
  })

  it('forks on cwd without touching the original', () => {
    const session = makeSession()
    const forked = forkForCall(session, '/other', undefined)
    expect(forked).not.toBe(session)
    expect(forked.cwd).toBe('/other')
    expect(session.cwd).toBe('/home')
  })

  it('layers env overrides on top of the session env', () => {
    const session = makeSession()
    const forked = forkForCall(session, undefined, { B: '9', C: '3' })
    expect(forked.env).toEqual({
      A: '1',
      B: '9',
      C: '3',
      PWD: '/home',
      PATH: '/usr/bin',
      IFS: ' \t\n',
      OPTIND: '1',
      OPTERR: '1',
    })
    expect(session.env).toEqual({
      A: '1',
      B: '2',
      PWD: '/home',
      PATH: '/usr/bin',
      IFS: ' \t\n',
      OPTIND: '1',
      OPTERR: '1',
    })
  })
})

function processOf(pid: number, parent: number | null): Process {
  return {
    id: new ProcessId('w', pid),
    sessionId: 's1',
    line: null,
    parent,
    group: 1,
    command: 'sh',
    cwd: PathSpec.fromStrPath('/'),
    machine: LOCAL_MACHINE,
    startedAt: 0,
    runtime: null,
    machinePid: null,
    state: 'running',
    endedAt: null,
    exit: null,
    signal: null,
    error: null,
  }
}

// A process's tree is it and every process under it, however deep, and none
// of its siblings or its parent.
describe('processTree', () => {
  it('holds every process under the root', () => {
    const records = [
      processOf(1, null),
      processOf(2, 1),
      processOf(3, 2),
      processOf(4, 1),
      processOf(5, 3),
    ]
    expect([...processTree(records, 2)].sort()).toEqual([2, 3, 5])
    expect([...processTree(records, 4)]).toEqual([4])
    expect([...processTree(records, 9)]).toEqual([9])
  })
})
