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
import { writeTar } from '../../commands/builtin/tar_helper.ts'
import { OpsRegistry } from '../../ops/registry.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { gzip } from '../../utils/compress.ts'
import { getTestParser, stderrStr, stdoutStr } from '../fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'

// Direct port of tests/workspace/executor/test_archive_relay.py: member
// selectors stay off routing, extraction lands in the cwd or -C across
// mounts through relay doors, and tar -c and zip write across mounts the
// archive they would write on one.

const ENC = new TextEncoder()

async function tgzBytes(): Promise<Uint8Array> {
  const raw = await writeTar([
    {
      name: './memory/memory.json',
      data: ENC.encode('content:./memory/memory.json\n'),
      isFile: true,
      isDir: false,
      linkname: '',
    },
    {
      name: './other.txt',
      data: ENC.encode('content:./other.txt\n'),
      isFile: true,
      isDir: false,
      linkname: '',
    },
  ])
  return gzip(raw)
}

async function makeWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const root = new RAMVFS()
  const work = new RAMVFS()
  work.store.files.set('/files.tar.gz', await tgzBytes())
  const registry = new OpsRegistry()
  registry.registerVfs(root)
  registry.registerVfs(work)
  return new Workspace(
    { '/': root, '/work/': work },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
}

describe('tar member selectors and relay extraction', () => {
  it('a selector does not join routing', async () => {
    const ws = await makeWs()
    const io = await ws.shell('tar -xOzf /work/files.tar.gz ./memory/memory.json')
    expect(stderrStr(io)).toBe('')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('content:./memory/memory.json\n')
  })

  it('a -t selector lists only its subtree', async () => {
    const ws = await makeWs()
    const io = await ws.shell('tar -tzf /work/files.tar.gz ./memory')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('./memory/memory.json\n')
  })

  it('a miss reports Not found in archive and exits 2', async () => {
    const ws = await makeWs()
    const io = await ws.shell('tar -tzf /work/files.tar.gz nope')
    expect(io.exitCode).toBe(2)
    expect(stderrStr(io)).toBe(
      'tar: nope: Not found in archive\n' +
        'tar: Exiting with failure status due to previous errors\n',
    )
  })

  it('extraction lands in the cwd across mounts', async () => {
    const ws = await makeWs()
    const io = await ws.shell('tar -xzf /work/files.tar.gz')
    expect(io.exitCode).toBe(0)
    const cat = await ws.shell('cat /memory/memory.json')
    expect(stdoutStr(cat)).toBe('content:./memory/memory.json\n')
  })

  it('-C extracts into another mount', async () => {
    const ws = await makeWs()
    const io = await ws.shell('tar -xzf /work/files.tar.gz -C /dest')
    expect(stderrStr(io)).toBe('')
    expect(io.exitCode).toBe(0)
    const cat = await ws.shell('cat /dest/other.txt')
    expect(stdoutStr(cat)).toBe('content:./other.txt\n')
  })

  it('create writes the archive on another mount', async () => {
    const ws = await makeWs()
    await ws.shell('mkdir -p /src && echo hi > /src/f.txt')
    const io = await ws.shell('cd /src && tar -czf /work/backup.tgz .')
    expect(stderrStr(io)).toBe('')
    expect(io.exitCode).toBe(0)
    const list = await ws.shell('tar -tzf /work/backup.tgz')
    expect(stdoutStr(list)).toBe('./\n./f.txt\n')
    const cat = await ws.shell('tar -xOzf /work/backup.tgz ./f.txt')
    expect(stdoutStr(cat)).toBe('hi\n')
  })

  it('create gathers operands from two mounts', async () => {
    const ws = await makeWs()
    await ws.shell('mkdir -p /src && echo hi > /src/f.txt')
    const io = await ws.shell('tar -cf /work/both.tar -C /src f.txt -C /work files.tar.gz')
    expect(stderrStr(io)).toBe('')
    expect(io.exitCode).toBe(0)
    const list = await ws.shell('tar -tf /work/both.tar')
    expect(stdoutStr(list)).toBe('f.txt\nfiles.tar.gz\n')
  })
})

describe('zip across mounts', () => {
  it('zip -r of . lands on another mount without a ./ prefix', async () => {
    const ws = await makeWs()
    await ws.shell("mkdir -p /src/_rels && echo x > '/src/[Content_Types].xml'")
    await ws.shell('echo r > /src/_rels/.rels')
    const io = await ws.shell('cd /src && zip -qr /work/doc.docx .')
    expect(stderrStr(io)).toBe('')
    expect(io.exitCode).toBe(0)
    const list = await ws.shell('unzip -Z1 /work/doc.docx')
    expect(stdoutStr(list)).toBe('[Content_Types].xml\n_rels/\n_rels/.rels\n')
  })
})

async function makeNested(): Promise<Workspace> {
  const parser = await getTestParser()
  const data = new RAMVFS()
  const inner = new RAMVFS()
  const out = new RAMVFS()
  const registry = new OpsRegistry()
  registry.registerVfs(data)
  registry.registerVfs(inner)
  registry.registerVfs(out)
  const ws = new Workspace(
    { '/data/': data, '/data/d/inner/': inner, '/out/': out },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
  await ws.shell(
    'mkdir -p /data/d/real && echo r > /data/d/real/r.txt' +
      ' && echo i > /data/d/inner/i.txt && ln -s real /data/d/lnk',
  )
  return ws
}

describe('an archive on another mount matches one on the same mount', () => {
  it.each([
    ['cd /data/d && zip -r {} .', 'zip'],
    ['cd /data/d && zip -ry {} .', 'zip'],
    ['cd /data/d && tar -cvf {} .', 'tar'],
    ['cd /data/d && tar -chvf {} .', 'tar'],
  ])('%s', async (line, kind) => {
    const ws = await makeNested()
    const same = await ws.shell(line.replace('{}', `/data/out.${kind}`))
    await ws.shell(`rm /data/out.${kind}`)
    const cross = await ws.shell(line.replace('{}', `/out/out.${kind}`))
    expect([cross.exitCode, stdoutStr(cross), stderrStr(cross)]).toEqual([
      same.exitCode,
      stdoutStr(same),
      stderrStr(same),
    ])
    expect(stderrStr(cross)).toContain('file is on a different filesystem')
    expect(stdoutStr(cross)).not.toContain('i.txt')
  })
})
