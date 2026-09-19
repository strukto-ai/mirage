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

import { describe, expect, it, vi } from 'vitest'
import { command, crossCommand, RegisteredCommand } from './config.ts'
import { CommandSpec, Operand, Option } from './spec/types.ts'

const STUB_SPEC = new CommandSpec({ rest: new Operand({ type: 'path' }) })
const STUB_FN = () => Promise.resolve([null, { exitCode: 0 } as never] as [null, never])

describe('RegisteredCommand', () => {
  it('fills defaults: filetype=null, write=false', () => {
    const rc = new RegisteredCommand({
      name: 'cat',
      spec: STUB_SPEC,
      vfs: 'ram',
      fn: STUB_FN,
    })
    expect(rc.filetype).toBeNull()
    expect(rc.write).toBe(false)
    expect(rc.read).toBe(false)
    expect(rc.provisionFn).toBeNull()
    expect(rc.aggregate).toBeNull()
    expect(rc.src).toBeNull()
    expect(rc.dst).toBeNull()
  })
})

describe('command()', () => {
  it('lets a declared --version reach the handler', async () => {
    const fn = vi.fn(STUB_FN)
    const [rc] = command({
      name: 'custom',
      vfs: null,
      spec: new CommandSpec({ options: [new Option({ long: '--version' })] }),
      fn,
    })
    if (rc === undefined) throw new Error('expected a registered command')
    await rc.fn({} as never, [], [], {
      stdin: null,
      flags: { version: true },
      filetypeFns: null,
      cwd: '/',
    })
    expect(fn).toHaveBeenCalledOnce()
  })

  it('returns one RegisteredCommand per VFS when given a single string', () => {
    const out = command({ name: 'cat', vfs: 'ram', spec: STUB_SPEC, fn: STUB_FN })
    expect(out).toHaveLength(1)
    expect(out[0]?.name).toBe('cat')
    expect(out[0]?.vfs).toBe('ram')
  })

  it('returns one RegisteredCommand per VFS when given an array', () => {
    const out = command({ name: 'cat', vfs: ['ram', 'disk'], spec: STUB_SPEC, fn: STUB_FN })
    expect(out).toHaveLength(2)
    expect(out.map((r) => r.vfs)).toEqual(['ram', 'disk'])
  })

  it('passes through filetype, provision, aggregate, write', () => {
    const prov = () => 'p'
    const agg = () => new Uint8Array(0)
    const out = command({
      name: 'cat',
      vfs: 'ram',
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
      filetypeFns: null,
      cwd: '/',
    })
    if (result === null) throw new Error('expected result')
    expect(new TextDecoder().decode(result[0] as Uint8Array)).toContain('Services:\n  drive\n')
  })
})

describe('crossCommand()', () => {
  it('encodes VFS as "src->dst" and stores src/dst', () => {
    const rc = crossCommand({ name: 'cp', src: 'ram', dst: 'disk', spec: STUB_SPEC, fn: STUB_FN })
    expect(rc.vfs).toBe('ram->disk')
    expect(rc.src).toBe('ram')
    expect(rc.dst).toBe('disk')
  })
})

describe('RegisteredCommand.read', () => {
  // Whether the command's byte reads go through the cache gate, which is what
  // lets the mount registry skip its own pre-command reconcile.
  const make = (read?: boolean) =>
    new RegisteredCommand({
      name: 'cat',
      spec: STUB_SPEC,
      vfs: 's3',
      fn: STUB_FN,
      ...(read === undefined ? {} : { read }),
    })

  it('is carried from the init', () => {
    expect(make(true).read).toBe(true)
  })

  it('survives withOverrides', () => {
    // withOverrides rebuilds field by field, so this is the assertion that
    // catches a field silently dropping back to its default.
    expect(make(true).withOverrides({ fn: STUB_FN }).read).toBe(true)
  })

  it('reaches the registration through command()', () => {
    const [rc] = command({
      name: 'cat',
      vfs: 'ram',
      spec: STUB_SPEC,
      fn: STUB_FN,
      read: true,
    })
    expect(rc?.read).toBe(true)
  })
})
