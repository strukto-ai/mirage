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
import { command, crossCommand, RegisteredCommand } from './config.ts'
import { CommandSpec, Operand, OperandKind } from './spec/types.ts'

const STUB_SPEC = new CommandSpec({ rest: new Operand({ kind: OperandKind.PATH }) })
const STUB_FN = () => Promise.resolve([null, { exitCode: 0 } as never] as [null, never])

describe('RegisteredCommand', () => {
  it('fills defaults: filetype=null, write=false', () => {
    const rc = new RegisteredCommand({
      name: 'cat',
      spec: STUB_SPEC,
      resource: 'ram',
      fn: STUB_FN,
    })
    expect(rc.filetype).toBeNull()
    expect(rc.write).toBe(false)
    expect(rc.provisionFn).toBeNull()
    expect(rc.aggregate).toBeNull()
    expect(rc.src).toBeNull()
    expect(rc.dst).toBeNull()
  })
})

describe('command()', () => {
  it('returns one RegisteredCommand per resource when given a single string', () => {
    const out = command({ name: 'cat', resource: 'ram', spec: STUB_SPEC, fn: STUB_FN })
    expect(out).toHaveLength(1)
    expect(out[0]?.name).toBe('cat')
    expect(out[0]?.resource).toBe('ram')
  })

  it('returns one RegisteredCommand per resource when given an array', () => {
    const out = command({ name: 'cat', resource: ['ram', 'disk'], spec: STUB_SPEC, fn: STUB_FN })
    expect(out).toHaveLength(2)
    expect(out.map((r) => r.resource)).toEqual(['ram', 'disk'])
  })

  it('passes through filetype, provision, aggregate, write', () => {
    const prov = () => 'p'
    const agg = () => new Uint8Array(0)
    const out = command({
      name: 'cat',
      resource: 'ram',
      spec: STUB_SPEC,
      fn: STUB_FN,
      filetype: '.json',
      provision: prov,
      aggregate: agg,
      write: true,
    })
    expect(out[0]?.filetype).toBe('.json')
    expect(out[0]?.provisionFn).toBe(prov)
    expect(out[0]?.aggregate).toBe(agg)
    expect(out[0]?.write).toBe(true)
  })

  it('accepts resource=null for general commands', () => {
    const out = command({ name: 'echo', resource: null, spec: STUB_SPEC, fn: STUB_FN })
    expect(out[0]?.resource).toBeNull()
  })
})

describe('crossCommand()', () => {
  it('encodes resource as "src->dst" and stores src/dst', () => {
    const rc = crossCommand({ name: 'cp', src: 'ram', dst: 'disk', spec: STUB_SPEC, fn: STUB_FN })
    expect(rc.resource).toBe('ram->disk')
    expect(rc.src).toBe('ram')
    expect(rc.dst).toBe('disk')
  })
})
