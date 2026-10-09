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

import { MountMode, WritePolicy } from '@struktoai/mirage-core/types'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Workspace } from '../../workspace.ts'
import { InlineDropbox } from '../fixtures/dropbox.ts'
import { buildVfs } from '../registry.ts'

const STALE = 'changed since it was read; read it again before writing'
const ENC = new TextEncoder()
const DEC = new TextDecoder()
const SEED: Record<string, string> = { f: 'one\n', g: 'gee\n', 'd/a': 'a\n', 'd/b': 'b\n' }
const CONFIG = { client_id: 'i', client_secret: 's', refresh_token: 'r' }

async function run(ws: Workspace, line: string): Promise<[number, string, string]> {
  const r = await ws.shell(line)
  return [r.exitCode, DEC.decode(r.stdout), DEC.decode(r.stderr)]
}

function refusal(verb: string): string {
  if (verb === 'cp') return `cp: cannot create regular file '/dbx/g': ${STALE}\n`
  return `mv: cannot move '/dbx/f' to '/dbx/g': '/dbx/g' ${STALE}\n`
}

function text(dropbox: InlineDropbox, path: string): string | undefined {
  const data = dropbox.read(path)
  return data === undefined ? undefined : DEC.decode(data)
}

describe('conditional writes on a Dropbox mount', () => {
  let dropbox: InlineDropbox
  const built: Workspace[] = []

  async function workspace(write: WritePolicy = WritePolicy.CONDITIONAL): Promise<Workspace> {
    const vfs = await buildVfs('dropbox', { ...CONFIG, endpoint: dropbox.url })
    const ws = new Workspace({ '/dbx': new Mount(vfs, { mode: MountMode.WRITE, write }) })
    built.push(ws)
    return ws
  }

  beforeEach(() => {
    dropbox = new InlineDropbox(
      Object.fromEntries(Object.entries(SEED).map(([k, v]) => [k, ENC.encode(v)])),
    )
    vi.stubGlobal('fetch', dropbox.fetch)
  })

  afterEach(async () => {
    for (const ws of built.splice(0)) await ws.close()
    vi.unstubAllGlobals()
  })

  it('refuses a changed file before any upload', async () => {
    const ws = await workspace()
    await run(ws, 'cat /dbx/f')
    dropbox.write('f', ENC.encode('theirs\n'))
    const uploads = dropbox.count('upload')
    const [code, , err] = await run(ws, 'echo mine > /dbx/f')
    expect([code, err]).toEqual([1, `/dbx/f: ${STALE}\n`])
    expect(dropbox.count('upload')).toBe(uploads)
    expect(text(dropbox, 'f')).toBe('theirs\n')
  })

  it('refuses through Dropbox a write landing after the lookup', async () => {
    const ws = await workspace()
    await run(ws, 'cat /dbx/f')
    dropbox.hooks.set('upload', () => {
      dropbox.write('f', ENC.encode('theirs\n'))
    })
    const [code, , err] = await run(ws, 'echo mine > /dbx/f')
    expect([code, err]).toEqual([1, `/dbx/f: ${STALE}\n`])
    expect(text(dropbox, 'f')).toBe('theirs\n')
  })

  it.each(['echo x >> /dbx/f', 'truncate -s 2 /dbx/f'])(
    'carries the version of its own read: %s',
    async (line) => {
      const ws = await workspace()
      dropbox.hooks.set('upload', () => {
        dropbox.write('f', ENC.encode('theirs\n'))
      })
      const [code, , err] = await run(ws, line)
      expect(code).toBe(1)
      expect(err).toContain(STALE)
      expect(text(dropbox, 'f')).toBe('theirs\n')
    },
  )

  it('refuses rm of a changed file and keeps it', async () => {
    const ws = await workspace()
    await run(ws, 'cat /dbx/f')
    dropbox.write('f', ENC.encode('theirs\n'))
    const [code, , err] = await run(ws, 'rm /dbx/f')
    expect([code, err]).toEqual([1, `rm: cannot remove '/dbx/f': ${STALE}\n`])
    expect(dropbox.count('delete')).toBe(0)
    expect(text(dropbox, 'f')).toBe('theirs\n')
  })

  it('pins rm of an unread file to its lookup', async () => {
    const ws = await workspace()
    dropbox.hooks.set('delete', () => {
      dropbox.write('f', ENC.encode('theirs\n'))
    })
    const [code, , err] = await run(ws, 'rm /dbx/f')
    expect([code, err]).toEqual([1, `rm: cannot remove '/dbx/f': ${STALE}\n`])
    expect(text(dropbox, 'f')).toBe('theirs\n')
  })

  it('rm -r removes an unchanged folder', async () => {
    dropbox.write('d/s/x', ENC.encode('x\n'))
    const ws = await workspace()
    expect(await run(ws, 'rm -r /dbx/d; ls /dbx')).toEqual([0, 'f\ng\n', ''])
  })

  it('refuses cp onto a changed destination', async () => {
    const ws = await workspace()
    await run(ws, 'cat /dbx/g')
    dropbox.write('g', ENC.encode('theirs\n'))
    expect(await run(ws, 'cp /dbx/f /dbx/g')).toEqual([1, '', refusal('cp')])
    expect([text(dropbox, 'f'), text(dropbox, 'g')]).toEqual(['one\n', 'theirs\n'])
  })

  it.each([
    ['mv', 'move'],
    ['cp', 'copy'],
  ])('%s stays refused on a destination recreated after its clear', async (verb, route) => {
    const ws = await workspace()
    await run(ws, 'cat /dbx/g')
    dropbox.hooks.set('delete', () => {
      dropbox.hooks.set(route, () => {
        dropbox.write('g', ENC.encode('new\n'))
      })
    })
    expect(await run(ws, `${verb} /dbx/f /dbx/g`)).toEqual([1, '', refusal(verb)])
    expect(dropbox.count('delete')).toBe(1)
    expect(await run(ws, `${verb} /dbx/f /dbx/g`)).toEqual([1, '', refusal(verb)])
    expect(dropbox.count('delete')).toBe(1)
    expect(text(dropbox, 'g')).toBe('new\n')
    expect(await run(ws, 'echo x > /dbx/f')).toEqual([0, '', ''])
  })

  it.each([
    ['mv', 'move'],
    ['cp', 'copy'],
  ])('%s of a vanished source costs a read destination nothing', async (verb, route) => {
    const ws = await workspace()
    await run(ws, 'ls /dbx; cat /dbx/g')
    dropbox.delete('f')
    const [code, , err] = await run(ws, `${verb} /dbx/f /dbx/g`)
    expect(code).toBe(1)
    expect(err).toContain('No such file or directory')
    expect(dropbox.count(route)).toBe(1)
    expect(dropbox.count('delete')).toBe(0)
    expect(text(dropbox, 'g')).toBe('gee\n')
  })

  it.each(['cp', 'mv'])('refuses once %s onto a destination gone since its read', async (verb) => {
    const ws = await workspace()
    await run(ws, 'cat /dbx/g')
    dropbox.delete('g')
    expect(await run(ws, `${verb} /dbx/f /dbx/g`)).toEqual([1, '', refusal(verb)])
    expect([text(dropbox, 'f'), text(dropbox, 'g')]).toEqual(['one\n', undefined])
    expect(await run(ws, `${verb} /dbx/f /dbx/g`)).toEqual([0, '', ''])
    expect(text(dropbox, 'g')).toBe('one\n')
  })

  it('costs a held write one lookup more than a plain one', async () => {
    const routes: string[][] = []
    for (const policy of [WritePolicy.UNCONDITIONAL, WritePolicy.CONDITIONAL]) {
      const ws = await workspace(policy)
      await run(ws, 'cat /dbx/f')
      const before = dropbox.log.length
      await run(ws, 'echo mine > /dbx/f')
      routes.push(dropbox.log.slice(before).filter((r) => r !== 'token'))
      dropbox.write('f', ENC.encode(SEED.f ?? ''))
    }
    expect(routes).toEqual([
      ['upload', 'upload'],
      ['get_metadata', 'upload', 'get_metadata', 'upload'],
    ])
  })

  it.each(['cp', 'mv'])('lets the line write after %s onto a read file', async (verb) => {
    const ws = await workspace()
    const line = `cat /dbx/g > /dev/null; ${verb} /dbx/f /dbx/g; echo x > /dbx/g`
    expect(await run(ws, line)).toEqual([0, '', ''])
    expect(text(dropbox, 'g')).toBe('x\n')
  })

  it("rm -r stopped partway keeps the changed file's version", async () => {
    for (const key of ['d/a', 'd/b']) dropbox.delete(key)
    dropbox.write('d/s/x', ENC.encode('x\n'))
    dropbox.write('d/t/y', ENC.encode('y\n'))
    const ws = await workspace()
    await run(ws, 'cat /dbx/d/s/x')
    dropbox.write('d/s/x', ENC.encode('theirs\n'))
    dropbox.hooks.set('delete', () => {
      dropbox.write('d/t/late', ENC.encode('late\n'))
    })
    const [code, , err] = await run(ws, 'rm -r /dbx/d')
    expect(code).toBe(1)
    expect(err).toContain('Directory not empty')
    expect(await run(ws, 'echo z > /dbx/d/s/x')).toEqual([1, '', `/dbx/d/s/x: ${STALE}\n`])
    expect(text(dropbox, 'd/s/x')).toBe('theirs\n')
  })

  it('rm -r keeps a file changed during the walk', async () => {
    const ws = await workspace()
    dropbox.hooks.set('delete', () => {
      dropbox.write('d/b', ENC.encode('theirs\n'))
    })
    expect(await run(ws, 'rm -r /dbx/d')).toEqual([
      1,
      '',
      `rm: cannot remove '/dbx/d/b': ${STALE}\n`,
    ])
    expect([text(dropbox, 'd/a'), text(dropbox, 'd/b')]).toEqual([undefined, 'theirs\n'])
  })

  it.each(['cp', 'mv'])('refuses %s onto a destination changed during its clear', async (verb) => {
    const ws = await workspace()
    await run(ws, 'cat /dbx/g')
    dropbox.hooks.set('delete', () => {
      dropbox.write('g', ENC.encode('theirs\n'))
    })
    expect(await run(ws, `${verb} /dbx/f /dbx/g`)).toEqual([1, '', refusal(verb)])
    expect([text(dropbox, 'f'), text(dropbox, 'g')]).toEqual(['one\n', 'theirs\n'])
  })

  it.each([
    ['mv away', 'mv /dbx/g /dbx/h', 'g'],
    ['mv of an ancestor', 'mv /dbx/d /dbx/e', 'd/a'],
  ])('a move lifts a kept version: %s', async (_name, line, key) => {
    const ws = await workspace()
    await run(ws, `cat /dbx/${key}`)
    dropbox.write(key, ENC.encode('theirs\n'))
    const refusedThenMoved = `echo x > /dbx/${key}; ${line}; echo new > /dbx/${key}`
    expect(await run(ws, refusedThenMoved)).toEqual([0, '', `/dbx/${key}: ${STALE}\n`])
    expect(text(dropbox, key)).toBe('new\n')
  })

  it.each([
    ['unconditional', WritePolicy.UNCONDITIONAL],
    ['conditional', WritePolicy.CONDITIONAL],
  ])('an empty resize reads nothing: %s', async (_name, policy) => {
    const ws = await workspace(policy)
    expect(await run(ws, 'truncate -s 0 /dbx/f')).toEqual([0, '', ''])
    expect(dropbox.count('download')).toBe(0)
    expect(text(dropbox, 'f')).toBe('')
  })

  it('holds the bytes a read through an outdated listing returned', async () => {
    const ws = await workspace()
    await run(ws, 'ls /dbx')
    dropbox.write('f', ENC.encode('B\n'))
    expect(await run(ws, 'cat /dbx/f')).toEqual([0, 'B\n', ''])
    dropbox.write('f', ENC.encode('C\n'))
    const [code, , err] = await run(ws, 'echo mine > /dbx/f')
    expect([code, err]).toEqual([1, `/dbx/f: ${STALE}\n`])
    expect(text(dropbox, 'f')).toBe('C\n')
  })

  it.each([
    ['cp', 'copy'],
    ['mv', 'move'],
  ])('refuses %s onto a destination a folder took, deleting nothing', async (verb, route) => {
    const ws = await workspace()
    await run(ws, 'cat /dbx/g')
    dropbox.hooks.set(route, () => {
      dropbox.delete('g')
      dropbox.write('g/x', ENC.encode('x\n'))
    })
    expect(await run(ws, `${verb} /dbx/f /dbx/g`)).toEqual([1, '', refusal(verb)])
    expect(dropbox.count('delete')).toBe(0)
    expect([text(dropbox, 'f'), text(dropbox, 'g/x')]).toEqual(['one\n', 'x\n'])
    dropbox.delete('g')
    expect(await run(ws, 'echo y > /dbx/g')).toEqual([0, '', ''])
  })

  it.each(['cp', 'mv'])('names a source gone before the retry for %s', async (verb) => {
    const ws = await workspace()
    await run(ws, 'cat /dbx/g')
    dropbox.hooks.set('delete', () => {
      dropbox.delete('f')
    })
    const missing =
      verb === 'cp'
        ? "cp: cannot create regular file '/dbx/g'"
        : "mv: cannot move '/dbx/f' to '/dbx/g'"
    expect(await run(ws, `${verb} /dbx/f /dbx/g`)).toEqual([
      1,
      '',
      `${missing}: No such file or directory\n`,
    ])
    expect(dropbox.count('delete')).toBe(1)
  })

  it.each([
    ['cp', 'copy'],
    ['mv', 'move'],
  ])('refuses once %s onto an unread destination retaken after its clear', async (verb, route) => {
    const ws = await workspace()
    dropbox.hooks.set('delete', () => {
      dropbox.hooks.set(route, () => {
        dropbox.write('g', ENC.encode('new\n'))
      })
    })
    expect(await run(ws, `${verb} /dbx/f /dbx/g`)).toEqual([1, '', refusal(verb)])
    expect(text(dropbox, 'g')).toBe('new\n')
    expect(await run(ws, `${verb} /dbx/f /dbx/g`)).toEqual([0, '', ''])
    expect(text(dropbox, 'g')).toBe('one\n')
  })

  it('rm -r names the first changed file and keeps both', async () => {
    const ws = await workspace()
    await run(ws, 'cat /dbx/d/a /dbx/d/b')
    dropbox.write('d/a', ENC.encode('theirs\n'))
    dropbox.write('d/b', ENC.encode('theirs\n'))
    expect(await run(ws, 'rm -r /dbx/d')).toEqual([
      1,
      '',
      `rm: cannot remove '/dbx/d/a': ${STALE}\n`,
    ])
    expect(await run(ws, 'echo x > /dbx/d/b')).toEqual([1, '', `/dbx/d/b: ${STALE}\n`])
  })

  it.each([
    ['cp', 'copy'],
    ['mv', 'move'],
  ])(
    "keeps no version when a folder retakes %s's destination after its clear",
    async (verb, route) => {
      const ws = await workspace()
      await run(ws, 'cat /dbx/g')
      dropbox.hooks.set('delete', () => {
        dropbox.hooks.set(route, () => {
          dropbox.write('g/x', ENC.encode('x\n'))
        })
      })
      expect(await run(ws, `${verb} /dbx/f /dbx/g`)).toEqual([1, '', refusal(verb)])
      dropbox.delete('g')
      expect(await run(ws, 'echo y > /dbx/g')).toEqual([0, '', ''])
    },
  )
})
