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
import { failed, ok, ScriptedMachine } from '../../../tests/fixtures/machine.ts'
import { bound, spec } from '../../../tests/fixtures/machine_files.ts'
import { create } from './create.ts'
import { pwrite } from './pwrite.ts'
import { truncate } from './truncate.ts'
import { write, writeCommand } from './write.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

describe('writeCommand', () => {
  it('replaces, appends or stages', () => {
    expect(writeCommand('/tmp/x', false, false)).toBe("cat > '/tmp/x'")
    expect(writeCommand('/tmp/x', true, false)).toBe("cat >> '/tmp/x'")
    const staged = writeCommand('/tmp/x', false, true)
    const name = staged.split(' ')[2] ?? ''
    expect(name.startsWith("'/tmp/x.mirage-")).toBe(true)
    expect(staged).toBe(
      `cat > ${name} && mv -f -- ${name} '/tmp/x' || { rm -f -- ${name}; exit 1; }`,
    )
  })
})

describe('write', () => {
  it('streams the bytes to cat', async () => {
    const machine = new ScriptedMachine('box', () => ok())
    await write(bound([machine]), 'box', spec('/x'), ENC.encode('hello'))
    expect(machine.lines).toEqual(["cat > '/tmp/x'"])
    expect(machine.fed.map((d) => (d === null ? null : DEC.decode(d)))).toEqual(['hello'])
  })

  it('raises the error a machine refusing it gives', async () => {
    const machine = new ScriptedMachine('box', () =>
      failed('sh: 1: cannot create /tmp/d: Is a directory\n', 2),
    )
    await expect(write(bound([machine]), 'box', spec('/d'), ENC.encode('x'))).rejects.toMatchObject(
      { code: 'EISDIR' },
    )
  })

  it('goes through the file API on a machine without input', async () => {
    const machine = new ScriptedMachine('box', () => ok(), false)
    const accessor = bound([machine])
    await write(accessor, 'box', spec('/x'), ENC.encode('new'))
    await write(accessor, 'box', spec('/y'), ENC.encode('+'), true)
    await pwrite(accessor, 'box', spec('/z'), ENC.encode('AB'), 5)
    const put = [...machine.put].map(([k, v]) => [k, DEC.decode(v)] as const)
    const stage = (base: string): string =>
      put.find(([k]) => k.startsWith(`${base}.mirage-`))?.[0] ?? ''
    const [y, z] = [stage('/tmp/y'), stage('/tmp/z')]
    expect(Object.fromEntries(put)).toEqual({ '/tmp/x': 'new', [y]: '+', [z]: 'AB' })
    expect(machine.lines).toEqual([
      `cat -- '${y}' >> '/tmp/y'; s=$?; rm -f -- '${y}'; exit $s`,
      `dd if='${z}' of='/tmp/z' seek=5 oflag=seek_bytes conv=notrunc status=none; s=$?; rm -f -- '${z}'; exit $s`,
    ])
    expect(machine.fed.every((f) => f === null)).toBe(true)
  })
})

describe('pwrite, create and truncate', () => {
  it('run one line each', async () => {
    const machine = new ScriptedMachine('box', () => ok())
    const accessor = bound([machine])
    await pwrite(accessor, 'box', spec('/x'), ENC.encode('ab'), 7)
    await create(accessor, 'box', spec('/x'))
    await truncate(accessor, 'box', spec('/x'), 4, true)
    expect(machine.lines).toEqual([
      "dd of='/tmp/x' seek=7 oflag=seek_bytes conv=notrunc status=none",
      ": >> '/tmp/x'",
      "truncate -c -s 4 -- '/tmp/x'",
    ])
  })
})
