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

import { RAM_COMMANDS } from './index.ts'
import { describe, expect, it } from 'vitest'
import type { RegisteredCommand } from '../../config.ts'
import { materialize } from '../../../io/types.ts'
import { RAMResource } from '../../../resource/ram/ram.ts'
import { PathSpec } from '../../../types.ts'
const RAM_TAR = RAM_COMMANDS.filter((c) => c.name === 'tar' && c.filetype == null)
const RAM_ZIP = RAM_COMMANDS.filter((c) => c.name === 'zip' && c.filetype == null)
const RAM_UNZIP = RAM_COMMANDS.filter((c) => c.name === 'unzip' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

interface CmdResult {
  out: Uint8Array
  writes: Record<string, Uint8Array>
  exitCode: number
}

async function runCmd(
  reg: readonly RegisteredCommand[],
  resource: RAMResource,
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]>,
): Promise<CmdResult> {
  const cmd = reg[0]
  if (cmd === undefined) throw new Error('not registered')
  const result = await cmd.fn(resource.accessor, paths, [], {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource,
  })
  if (result === null) return { out: new Uint8Array(), writes: {}, exitCode: 0 }
  const [output, io] = result as [unknown, { writes: Record<string, Uint8Array>; exitCode: number }]
  let outBytes: Uint8Array = new Uint8Array()
  if (output !== null) {
    outBytes =
      output instanceof Uint8Array ? output : await materialize(output as AsyncIterable<Uint8Array>)
  }
  return { out: outBytes, writes: io.writes, exitCode: io.exitCode }
}

describe('tar', () => {
  it('creates an archive and lists its contents', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/a.txt', ENC.encode('aaa'))
    resource.store.files.set('/b.txt', ENC.encode('bbb'))
    await runCmd(
      RAM_TAR,
      resource,
      [PathSpec.fromStrPath('/a.txt'), PathSpec.fromStrPath('/b.txt')],
      { c: true, f: '/archive.tar' },
    )
    expect(resource.store.files.has('/archive.tar')).toBe(true)
    const { out } = await runCmd(RAM_TAR, resource, [], { t: true, f: '/archive.tar' })
    const decoded = DEC.decode(out)
    expect(decoded).toContain('a.txt')
    expect(decoded).toContain('b.txt')
  })

  it('extracts an archive back to files', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/a.txt', ENC.encode('content_a'))
    await runCmd(RAM_TAR, resource, [PathSpec.fromStrPath('/a.txt')], {
      c: true,
      f: '/archive.tar',
    })
    resource.store.files.delete('/a.txt')
    await runCmd(RAM_TAR, resource, [], { x: true, f: '/archive.tar', C: '/' })
    expect(resource.store.files.has('/a.txt')).toBe(true)
    expect(DEC.decode(resource.store.files.get('/a.txt'))).toBe('content_a')
  })
})

describe('zip / unzip', () => {
  it('zip then unzip -l lists the archived file', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/a.txt', ENC.encode('hello'))
    await runCmd(
      RAM_ZIP,
      resource,
      [PathSpec.fromStrPath('/out.zip'), PathSpec.fromStrPath('/a.txt')],
      {},
    )
    expect(resource.store.files.has('/out.zip')).toBe(true)
    const { out } = await runCmd(RAM_UNZIP, resource, [PathSpec.fromStrPath('/out.zip')], {
      args_l: true,
    })
    expect(DEC.decode(out)).toContain('a.txt')
  })

  it('zip then unzip -d round trip restores file contents', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/a.txt', ENC.encode('zip_content'))
    await runCmd(
      RAM_ZIP,
      resource,
      [PathSpec.fromStrPath('/out.zip'), PathSpec.fromStrPath('/a.txt')],
      {},
    )
    resource.store.files.delete('/a.txt')
    await runCmd(RAM_UNZIP, resource, [PathSpec.fromStrPath('/out.zip')], { d: '/' })
    expect(resource.store.files.has('/a.txt')).toBe(true)
    expect(DEC.decode(resource.store.files.get('/a.txt'))).toBe('zip_content')
  })

  it('zip -j junks paths, keeping only basename', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/sub')
    resource.store.files.set('/sub/deep.txt', ENC.encode('hello'))
    await runCmd(
      RAM_ZIP,
      resource,
      [PathSpec.fromStrPath('/out.zip'), PathSpec.fromStrPath('/sub/deep.txt')],
      { j: true },
    )
    const { out } = await runCmd(RAM_UNZIP, resource, [PathSpec.fromStrPath('/out.zip')], {
      args_l: true,
    })
    const text = DEC.decode(out)
    expect(text).toContain('deep.txt')
    expect(text).not.toContain('sub/')
  })

  it('zip -q suppresses stdout', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/a.txt', ENC.encode('hello'))
    const { out } = await runCmd(
      RAM_ZIP,
      resource,
      [PathSpec.fromStrPath('/out.zip'), PathSpec.fromStrPath('/a.txt')],
      { q: true },
    )
    expect(out.byteLength).toBe(0)
  })
})
