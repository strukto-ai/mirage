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
import { ScriptedMachine } from '../../../tests/fixtures/machine.ts'
import {
  bound,
  FakeFiles,
  holding,
  holdingSince,
  spec,
} from '../../../tests/fixtures/machine_files.ts'
import { currentCaller, bindCaller } from '../../context/session_context.ts'
import { MachineName } from '../../execution/types.ts'
import {
  chosen,
  commandMachine,
  holder,
  holders,
  kernelView,
  newNameMachine,
  runningMachine,
  writeMachine,
} from './place.ts'
import { Holder } from './types.ts'

function runningOn<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return bindCaller({ ...currentCaller(), machine: new MachineName('scripted', name) }, fn)
}

function preferring<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return bindCaller({ ...currentCaller(), preferredMachine: name }, fn)
}

describe('placement', () => {
  it('asks nothing on one machine', async () => {
    const machine = new ScriptedMachine('box', holding())
    const accessor = bound([machine])
    expect(await holders(accessor, spec('/x'))).toEqual([new Holder('box')])
    expect(await writeMachine(accessor, spec('/x'))).toBe('box')
    expect(machine.lines).toEqual([])
  })

  it('lands a new name on one machine there, unasked', async () => {
    const machine = new ScriptedMachine('box', holding())
    const accessor = bound([machine])
    expect(await newNameMachine(accessor, spec('/d/new'))).toBe('box')
    expect(await newNameMachine(accessor, spec('/d/e/new'), true)).toBe('box')
    expect(machine.lines).toEqual([])
  })

  it('reads a name where it is', async () => {
    const accessor = bound([
      new ScriptedMachine('a', holding()),
      new ScriptedMachine('b', holding('/tmp/out.csv')),
    ])
    expect(await holder(accessor, spec('/out.csv'))).toBe('b')
    await expect(holder(accessor, spec('/none'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('takes a name on two machines from the copy written last', async () => {
    const old = new ScriptedMachine('old', holdingSince(1700000000, '/tmp/x'))
    const fresh = new ScriptedMachine('new', holdingSince(1700000009, '/tmp/x'))
    expect(await holder(bound([old, fresh]), spec('/x'))).toBe('new')
    expect(await holder(bound([fresh, old]), spec('/x'))).toBe('new')
    const held = await holders(bound([old, fresh]), spec('/x'))
    expect(held.map((one) => one.machine)).toEqual(['old', 'new'])
    expect(held.map((one) => one.written)).toEqual([1700000000000, 1700000009000])
  })

  it("lets a newer copy win over the command's machine", async () => {
    const accessor = bound([
      new ScriptedMachine('old', holdingSince(1700000000, '/tmp/x')),
      new ScriptedMachine('new', holdingSince(1700000009, '/tmp/x')),
    ])
    await runningOn('old', async () => {
      expect(await holder(accessor, spec('/x'))).toBe('new')
    })
  })

  it("sends copies written together to the command's machine", async () => {
    const accessor = bound([
      new ScriptedMachine('a', holding('/tmp/x')),
      new ScriptedMachine('b', holding('/tmp/x')),
    ])
    expect(await holder(accessor, spec('/x'))).toBe('a')
    await runningOn('b', async () => {
      expect(runningMachine(accessor)).toBe('b')
      expect(commandMachine(accessor)).toBe('b')
      expect(await holder(accessor, spec('/x'))).toBe('b')
    })
    await preferring('b', async () => {
      expect(runningMachine(accessor)).toBeNull()
      expect(commandMachine(accessor)).toBe('b')
      expect(await holder(accessor, spec('/x'))).toBe('b')
    })
  })

  it("puts a program's machine before the preferred one", async () => {
    const accessor = bound([
      new ScriptedMachine('a', holding()),
      new ScriptedMachine('b', holding()),
    ])
    await bindCaller(
      { ...currentCaller(), machine: new MachineName('scripted', 'b'), preferredMachine: 'a' },
      () => {
        expect(commandMachine(accessor)).toBe('b')
        return Promise.resolve()
      },
    )
  })

  it("does not take a machine off the mount as the command's", async () => {
    const accessor = bound(
      [new ScriptedMachine('a', holding()), new ScriptedMachine('b', holding())],
      { machines: ['a'] },
    )
    await preferring('b', () => {
      expect(commandMachine(accessor)).toBeNull()
      return Promise.resolve()
    })
  })

  it("answers a kernel's view for the command's machine", async () => {
    const a = new ScriptedMachine('a', holdingSince(1700000000, '/proc/cpuinfo'))
    const b = new ScriptedMachine('b', holdingSince(1700000009, '/proc/cpuinfo'))
    const accessor = bound([a, b], { root: '/' })
    const path = spec('/proc/cpuinfo', '')
    expect(kernelView(accessor, path)).toBe('a')
    expect(await holder(accessor, path)).toBe('a')
    expect(b.lines).toEqual([])
    await preferring('b', async () => {
      expect(await holder(accessor, path)).toBe('b')
    })
    expect(kernelView(accessor, spec('/tmp/x', ''))).toBeNull()
    expect(kernelView(bound([a], { root: '/' }), path)).toBeNull()
  })

  it('takes the only holder unasked', () => {
    const accessor = bound([new ScriptedMachine('a', holding())])
    expect(chosen(accessor, [new Holder('a')])).toEqual(new Holder('a'))
  })

  it("lands a new name on the command's machine, else the default", async () => {
    const accessor = bound([
      new ScriptedMachine('a', new FakeFiles().answer),
      new ScriptedMachine('b', new FakeFiles().answer),
    ])
    expect(accessor.defaultMachine).toBe('a')
    expect(await writeMachine(accessor, spec('/new'))).toBe('a')
    await runningOn('b', async () => {
      expect(await writeMachine(accessor, spec('/new'))).toBe('b')
    })
    await preferring('b', async () => {
      expect(await writeMachine(accessor, spec('/new'))).toBe('b')
    })
  })

  it('lands a new name where its folder is', async () => {
    const accessor = bound([
      new ScriptedMachine('a', new FakeFiles().answer),
      new ScriptedMachine('b', new FakeFiles({ '/tmp/d/kept': '1' }).answer),
    ])
    expect(await newNameMachine(accessor, spec('/d/new'))).toBe('b')
    expect(await writeMachine(accessor, spec('/d/new'))).toBe('b')
    await preferring('a', async () => {
      expect(await writeMachine(accessor, spec('/d/new'))).toBe('b')
    })
  })

  it('looks up to the nearest folder a machine holds when parents are made', async () => {
    const accessor = bound([
      new ScriptedMachine('a', new FakeFiles().answer),
      new ScriptedMachine('b', new FakeFiles({ '/tmp/g/kept': '1' }).answer),
    ])
    const deep = spec('/g/sub/deep')
    expect(await writeMachine(accessor, deep, { parents: true })).toBe('b')
    expect(await writeMachine(accessor, deep)).toBe('a')
    expect(await writeMachine(accessor, spec('/fresh/sub/deep'), { parents: true })).toBe('a')
  })

  it('writes an existing name where it is', async () => {
    const accessor = bound([
      new ScriptedMachine('a', holding()),
      new ScriptedMachine('b', holding('/tmp/kept')),
    ])
    await runningOn('a', async () => {
      expect(await writeMachine(accessor, spec('/kept'))).toBe('b')
    })
  })

  it("lands what a program replaces on the program's own machine", async () => {
    const accessor = bound([
      new ScriptedMachine('a', holding()),
      new ScriptedMachine('b', holding('/tmp/kept')),
    ])
    expect(await writeMachine(accessor, spec('/kept'), { replaces: true })).toBe('b')
    await runningOn('a', async () => {
      expect(await writeMachine(accessor, spec('/kept'), { replaces: true })).toBe('a')
    })
    await preferring('a', async () => {
      expect(await writeMachine(accessor, spec('/kept'), { replaces: true })).toBe('b')
    })
  })

  it('lets a configured default machine win', () => {
    const accessor = bound(
      [new ScriptedMachine('a', holding()), new ScriptedMachine('b', holding())],
      {
        defaultMachine: 'b',
      },
    )
    expect(accessor.defaultMachine).toBe('b')
  })

  it('refuses a mount naming no such machine', () => {
    expect(() => bound([new ScriptedMachine('a', holding())], { machines: ['gpu'] })).toThrow(
      "unknown machine: 'gpu'",
    )
  })
})
