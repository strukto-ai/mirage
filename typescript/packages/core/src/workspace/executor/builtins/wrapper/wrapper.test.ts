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
import { PLAIN_TRAITS, type ProcessTraits } from '../../../../execution/process/types.ts'
import { MountMode } from '../../../../types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../workspace/workspace.ts'
import { wrapperTraits } from './wrapper.ts'

const DEC = new TextDecoder()

describe('wrapperTraits', () => {
  const traits = (over: Partial<ProcessTraits>): ProcessTraits => ({ ...PLAIN_TRAITS, ...over })

  it.each([
    ['nice', ['gcc'], 0, traits({ niceness: 10, wrappers: ['nice'] }), ''],
    ['nice', ['-n', '5', 'gcc'], 2, traits({ niceness: 5, wrappers: ['nice', '-n', '5'] }), ''],
    [
      'nice',
      ['-n', '-5', 'gcc'],
      2,
      traits({ wrappers: ['nice', '-n', '-5'] }),
      'nice: cannot set niceness: Permission denied\n',
    ],
    ['nohup', ['gcc'], 0, traits({ ignores: new Set([1]), wrappers: ['nohup'] }), ''],
    ['setsid', ['-w', 'gcc'], 1, traits({ leads: true, wrappers: ['setsid', '-w'] }), ''],
    ['stdbuf', ['-oL', 'gcc'], 1, traits({ wrappers: ['stdbuf', '-oL'] }), ''],
  ] as [string, string[], number, ProcessTraits, string][])(
    '%s %j changes the traits of its program',
    (name, args, at, worn, warned) => {
      expect(wrapperTraits(name, args, at, PLAIN_TRAITS)).toEqual([worn, warned])
    },
  )

  it('never sets the niceness past 19', () => {
    const [worn] = wrapperTraits('nice', ['-n', '9', 'gcc'], 2, traits({ niceness: 15 }))
    expect(worn.niceness).toBe(19)
  })
})

it('a nohup job survives a hangup', async () => {
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.EXEC })
  try {
    const io = await ws.shell(
      'nohup sleep 3 & p=$!; sleep 0.2; kill -HUP $p; sleep 0.2; ' +
        'kill -0 $p && echo alive; kill $p; wait $p; echo rc=$?',
    )
    expect(DEC.decode(io.stdout)).toBe('alive\nrc=143\n')
  } finally {
    await ws.close()
  }
})

it.each([
  ['nice nice', '10\n'],
  ['nice sh -c nice', '10\n'],
  ["nice -n 3 sh -c 'nice -n 2 nice'", '5\n'],
  ['nohup nice -n 4 nice', '4\n'],
  ['nice -n 15 nice -n 9 nice', '19\n'],
])('nice prints the niceness its wrappers gave it: %s', async (line, out) => {
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.EXEC })
  try {
    expect(DEC.decode((await ws.shell(line)).stdout)).toBe(out)
  } finally {
    await ws.close()
  }
})

it("leaves the job alone where a shell's inner wrapper runs", async () => {
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.EXEC })
  try {
    const io = await ws.shell(
      "nice -n 0 sh -c 'nohup sleep 0; echo ready; sleep 3' & p=$!; " +
        'sleep 0.3; kill -HUP $p; sleep 0.2; ' +
        'kill -0 $p 2>/dev/null && echo alive; wait $p; echo rc=$?',
    )
    expect(DEC.decode(io.stdout)).toBe('ready\nrc=129\n')
  } finally {
    await ws.close()
  }
})
