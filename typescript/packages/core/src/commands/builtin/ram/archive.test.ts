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
  stderr: Uint8Array
}

async function runCmd(
  reg: readonly RegisteredCommand[],
  resource: RAMResource,
  paths: PathSpec[],
  flags: Record<string, string | boolean | number | string[]>,
  texts: string[] = [],
): Promise<CmdResult> {
  const cmd = reg[0]
  if (cmd === undefined) throw new Error('not registered')
  const result = await cmd.fn(resource.accessor, paths, texts, {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource,
  })
  if (result === null) {
    return { out: new Uint8Array(), writes: {}, exitCode: 0, stderr: new Uint8Array() }
  }
  const [output, io] = result as [
    unknown,
    { writes: Record<string, Uint8Array>; exitCode: number; stderr: Uint8Array | null },
  ]
  let outBytes: Uint8Array = new Uint8Array()
  if (output !== null) {
    outBytes =
      output instanceof Uint8Array ? output : await materialize(output as AsyncIterable<Uint8Array>)
  }
  return {
    out: outBytes,
    writes: io.writes,
    exitCode: io.exitCode,
    stderr: io.stderr ?? new Uint8Array(),
  }
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

describe('unzip members', () => {
  const APP = 'APPXML-CONTENT\n'
  const SHEET = 'SHEET1-CONTENT\n'
  const WORKBOOK = 'WORKBOOK-CONTENT\n'
  const CAUTION = 'caution: filename not matched:  '

  async function makeBook(): Promise<RAMResource> {
    const resource = new RAMResource()
    resource.store.dirs.add('/docProps')
    resource.store.dirs.add('/xl')
    resource.store.files.set('/docProps/app.xml', ENC.encode(APP))
    resource.store.files.set('/xl/sheet1.xml', ENC.encode(SHEET))
    resource.store.files.set('/xl/workbook.xml', ENC.encode(WORKBOOK))
    await runCmd(
      RAM_ZIP,
      resource,
      [
        PathSpec.fromStrPath('/book.zip'),
        PathSpec.fromStrPath('/docProps/app.xml'),
        PathSpec.fromStrPath('/xl/sheet1.xml'),
        PathSpec.fromStrPath('/xl/workbook.xml'),
      ],
      {},
    )
    return resource
  }

  function book(): PathSpec[] {
    return [PathSpec.fromStrPath('/book.zip')]
  }

  it('-p with a member outputs only that member', async () => {
    const resource = await makeBook()
    const r = await runCmd(RAM_UNZIP, resource, book(), { p: true }, ['xl/workbook.xml'])
    expect(DEC.decode(r.out)).toBe(WORKBOOK)
    expect(r.exitCode).toBe(0)
    expect(r.stderr.byteLength).toBe(0)
  })

  it('-p with a missing member exits 11 with a caution on stderr', async () => {
    const resource = await makeBook()
    const r = await runCmd(RAM_UNZIP, resource, book(), { p: true }, ['NOSUCHFILE.xml'])
    expect(r.out.byteLength).toBe(0)
    expect(r.exitCode).toBe(11)
    expect(DEC.decode(r.stderr)).toBe(`${CAUTION}NOSUCHFILE.xml\n`)
  })

  it('-p output follows archive order, not argument order', async () => {
    const resource = await makeBook()
    const r = await runCmd(RAM_UNZIP, resource, book(), { p: true }, [
      'xl/workbook.xml',
      'docProps/app.xml',
    ])
    expect(DEC.decode(r.out)).toBe(APP + WORKBOOK)
    expect(r.exitCode).toBe(0)
  })

  it('-p charges each entry to the first matching spec', async () => {
    const resource = await makeBook()
    const r = await runCmd(RAM_UNZIP, resource, book(), { p: true }, ['*.xml', 'xl/workbook.xml'])
    expect(DEC.decode(r.out)).toBe(APP + SHEET + WORKBOOK)
    expect(r.exitCode).toBe(11)
    expect(DEC.decode(r.stderr)).toBe(`${CAUTION}xl/workbook.xml\n`)
  })

  it('-p wildcard star crosses slashes', async () => {
    const resource = await makeBook()
    const r = await runCmd(RAM_UNZIP, resource, book(), { p: true }, ['doc*'])
    expect(DEC.decode(r.out)).toBe(APP)
    expect(r.exitCode).toBe(0)
  })

  it('-p wildcard selects a subtree', async () => {
    const resource = await makeBook()
    const r = await runCmd(RAM_UNZIP, resource, book(), { p: true }, ['xl/*'])
    expect(DEC.decode(r.out)).toBe(SHEET + WORKBOOK)
    expect(r.exitCode).toBe(0)
  })

  it('-p treats ? as one byte, the way Info-ZIP does', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/é.txt', ENC.encode('ACCENT\n'))
    resource.store.files.set('/ab.txt', ENC.encode('AB\n'))
    await runCmd(
      RAM_ZIP,
      resource,
      [
        PathSpec.fromStrPath('/bytes.zip'),
        PathSpec.fromStrPath('/é.txt'),
        PathSpec.fromStrPath('/ab.txt'),
      ],
      {},
    )
    const arch = [PathSpec.fromStrPath('/bytes.zip')]
    const one = await runCmd(RAM_UNZIP, resource, arch, { p: true }, ['?.txt'])
    expect(one.out.byteLength).toBe(0)
    expect(one.exitCode).toBe(11)
    expect(DEC.decode(one.stderr)).toBe(`${CAUTION}?.txt\n`)
    const two = await runCmd(RAM_UNZIP, resource, arch, { p: true }, ['??.txt'])
    expect(DEC.decode(two.out)).toBe('ACCENT\nAB\n')
    expect(two.exitCode).toBe(0)
  })

  it('-l filters rows and exits 11 only when nothing matched', async () => {
    const resource = await makeBook()
    const hit = await runCmd(RAM_UNZIP, resource, book(), { args_l: true }, ['xl/workbook.xml'])
    expect(DEC.decode(hit.out)).toContain('xl/workbook.xml')
    expect(DEC.decode(hit.out)).not.toContain('docProps/app.xml')
    expect(hit.exitCode).toBe(0)
    const miss = await runCmd(RAM_UNZIP, resource, book(), { args_l: true }, ['NOSUCHFILE.xml'])
    expect(miss.exitCode).toBe(11)
    expect(miss.stderr.byteLength).toBe(0)
    const partial = await runCmd(RAM_UNZIP, resource, book(), { args_l: true }, [
      'xl/workbook.xml',
      'NOSUCHFILE.xml',
    ])
    expect(partial.exitCode).toBe(0)
    expect(partial.stderr.byteLength).toBe(0)
  })

  it('-t reports unmatched members on stdout and exits 11', async () => {
    const resource = await makeBook()
    const r = await runCmd(RAM_UNZIP, resource, book(), { t: true }, [
      'xl/workbook.xml',
      'NOSUCHFILE.xml',
    ])
    const text = DEC.decode(r.out)
    expect(text).toContain(`${CAUTION}NOSUCHFILE.xml`)
    expect(text).toContain('At least one error was detected')
    expect(r.exitCode).toBe(11)
    expect(r.stderr.byteLength).toBe(0)
  })

  it('extraction writes only the selected members', async () => {
    const resource = await makeBook()
    const r = await runCmd(RAM_UNZIP, resource, book(), { d: '/ext' }, [
      'xl/workbook.xml',
      'NOSUCHFILE.xml',
    ])
    expect(resource.store.files.has('/ext/xl/workbook.xml')).toBe(true)
    expect(resource.store.files.has('/ext/docProps/app.xml')).toBe(false)
    expect(r.exitCode).toBe(11)
    expect(DEC.decode(r.stderr)).toBe(`${CAUTION}NOSUCHFILE.xml\n`)
  })
})
