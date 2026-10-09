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

import { materialize } from '../io/types.ts'
import { describe, expect, it, vi } from 'vitest'
import { command, Command } from './config.ts'
import { specOf } from './spec/builtins.ts'
import { CommandSpec, Argument } from './spec/types.ts'

const STUB_SPEC = new CommandSpec({
  arguments: [new Argument('paths', { metavar: '', type: 'path', nargs: '*' })],
})
const STUB_FN = () => Promise.resolve([null, { exitCode: 0 } as never] as [null, never])

describe('Command', () => {
  it('fills defaults: filetype=null, write=false', () => {
    const rc = new Command({
      name: 'cat',
      spec: STUB_SPEC,
      vfs: 'ram',
      fn: STUB_FN,
    })
    expect(rc.filetype).toBeNull()
    expect(rc.write).toBe(false)
    expect(rc.aggregate).toBeNull()
  })
})

describe('command()', () => {
  it('lets a declared --version reach the handler', async () => {
    const fn = vi.fn(STUB_FN)
    const [rc] = command({
      name: 'custom',
      vfs: null,
      spec: new CommandSpec({ arguments: [new Argument('--version', { action: 'store_true' })] }),
      fn,
    })
    if (rc === undefined) throw new Error('expected a registered command')
    await rc.fn({} as never, [], [], {
      stdin: null,
      flags: { version: true },
      cwd: '/',
    })
    expect(fn).toHaveBeenCalledOnce()
  })

  // jq answers --help where its loop reaches it (OWN_OPTION_LOOP); a command
  // that only borrows the name gets the wrapper's answer.
  it.each([
    ["jq's own grammar", specOf('jq'), 1],
    ['a borrowed jq name', STUB_SPEC, 0],
  ])('hands --help to the handler for %s', async (_, spec, calls) => {
    const fn = vi.fn(STUB_FN)
    const [rc] = command({ name: 'jq', vfs: null, spec, fn })
    if (rc === undefined) throw new Error('expected a registered command')
    await rc.fn({} as never, [], [], {
      stdin: null,
      flags: { help: true },
      cwd: '/',
    })
    expect(fn).toHaveBeenCalledTimes(calls)
  })

  it('returns one Command per VFS when given a single string', () => {
    const out = command({ name: 'cat', vfs: 'ram', spec: STUB_SPEC, fn: STUB_FN })
    expect(out).toHaveLength(1)
    expect(out[0]?.name).toBe('cat')
    expect(out[0]?.vfs).toBe('ram')
  })

  it('returns one Command per VFS when given an array', () => {
    const out = command({ name: 'cat', vfs: ['ram', 'disk'], spec: STUB_SPEC, fn: STUB_FN })
    expect(out).toHaveLength(2)
    expect(out.map((r) => r.vfs)).toEqual(['ram', 'disk'])
  })

  it('passes through filetype, aggregate, write', () => {
    const agg = () => new Uint8Array(0)
    const out = command({
      name: 'cat',
      vfs: 'ram',
      spec: STUB_SPEC,
      fn: STUB_FN,
      filetype: '.json',
      aggregate: agg,
      write: true,
    })
    expect(out[0]?.filetype).toBe('.json')
    expect(out[0]?.aggregate).toBe(agg)
    expect(out[0]?.write).toBe(true)
  })

  it('accepts VFS=null for general commands', () => {
    const out = command({ name: 'echo', vfs: null, spec: STUB_SPEC, fn: STUB_FN })
    expect(out[0]?.vfs).toBeNull()
  })

  it('keeps the spec epilog when injecting --help / --version', async () => {
    const out = command({
      name: 'gws',
      vfs: 'gdrive',
      spec: new CommandSpec({ epilog: 'Services:\n  drive' }),
      fn: STUB_FN,
    })
    const rc = out[0]
    if (rc === undefined) throw new Error('expected a registered command')
    expect(rc.spec.epilog).toBe('Services:\n  drive')
    const result = await rc.fn({} as never, [], [], {
      stdin: null,
      flags: { help: true },
      cwd: '/',
    })
    if (result === null) throw new Error('expected result')
    expect(new TextDecoder().decode(await materialize(result[0]))).toContain('Services:\n  drive\n')
  })
})
