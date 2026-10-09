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
import { Workspace } from '../workspace.ts'
import { InlineBox } from './fixtures/box.ts'
import { buildVfs } from './registry.ts'

const STALE = 'changed since it was read; read it again before writing'
const ENC = new TextEncoder()
const DEC = new TextDecoder()
const SEED: Record<string, string> = { f: 'one\n', g: 'gee\n', 'd/a': 'a\n', 'd/b': 'b\n' }

async function run(ws: Workspace, line: string): Promise<[number, string, string]> {
  const r = await ws.shell(line)
  return [r.exitCode, DEC.decode(r.stdout), DEC.decode(r.stderr)]
}

function refusal(verb: string): string {
  if (verb === 'cp') return `cp: cannot create regular file '/box/g': ${STALE}\n`
  return `mv: cannot move '/box/f' to '/box/g': '/box/g' ${STALE}\n`
}

function text(box: InlineBox, path: string): string | undefined {
  const data = box.read(path)
  return data === undefined ? undefined : DEC.decode(data)
}

describe('conditional writes on a Box mount', () => {
  let box: InlineBox
  const built: Workspace[] = []

  async function workspace(write: WritePolicy = WritePolicy.CONDITIONAL): Promise<Workspace> {
    const vfs = await buildVfs('box', { access_token: 't', endpoint: box.url })
    const ws = new Workspace({ '/box': new Mount(vfs, { mode: MountMode.WRITE, write }) })
    built.push(ws)
    return ws
  }

  beforeEach(() => {
    box = new InlineBox(
      Object.fromEntries(Object.entries(SEED).map(([k, v]) => [k, ENC.encode(v)])),
    )
    vi.stubGlobal('fetch', box.fetch)
  })

  afterEach(async () => {
    for (const ws of built.splice(0)) await ws.close()
    vi.unstubAllGlobals()
  })

  it('refuses a changed file before any upload', async () => {
    const ws = await workspace()
    await run(ws, 'cat /box/f')
    box.write('f', ENC.encode('theirs\n'))
    const uploads = box.count('upload')
    const [code, , err] = await run(ws, 'echo mine > /box/f')
    expect([code, err]).toEqual([1, `/box/f: ${STALE}\n`])
    expect(box.count('upload')).toBe(uploads)
    expect(text(box, 'f')).toBe('theirs\n')
  })

  it('refuses through Box a write landing after the lookup', async () => {
    const ws = await workspace()
    await run(ws, 'cat /box/f')
    box.hooks.set('upload', () => {
      box.write('f', ENC.encode('theirs\n'))
    })
    const [code, , err] = await run(ws, 'echo mine > /box/f')
    expect([code, err]).toEqual([1, `/box/f: ${STALE}\n`])
    expect(text(box, 'f')).toBe('theirs\n')
  })

  it.each(['echo x >> /box/f', 'truncate -s 2 /box/f'])(
    'carries the version of its own read: %s',
    async (line) => {
      const ws = await workspace()
      box.hooks.set('upload', () => {
        box.write('f', ENC.encode('theirs\n'))
      })
      const [code, , err] = await run(ws, line)
      expect(code).toBe(1)
      expect(err).toContain(STALE)
      expect(text(box, 'f')).toBe('theirs\n')
    },
  )

  it('refuses rm of a changed file and keeps it', async () => {
    const ws = await workspace()
    await run(ws, 'cat /box/f')
    box.write('f', ENC.encode('theirs\n'))
    const [code, , err] = await run(ws, 'rm /box/f')
    expect([code, err]).toEqual([1, `rm: cannot remove '/box/f': ${STALE}\n`])
    expect(box.count('delete')).toBe(0)
    expect(text(box, 'f')).toBe('theirs\n')
  })

  it('pins rm of an unread file to its lookup', async () => {
    const ws = await workspace()
    box.hooks.set('delete', () => {
      box.write('f', ENC.encode('theirs\n'))
    })
    const [code, , err] = await run(ws, 'rm /box/f')
    expect([code, err]).toEqual([1, `rm: cannot remove '/box/f': ${STALE}\n`])
    expect(text(box, 'f')).toBe('theirs\n')
  })

  it('rm -r removes an unchanged folder', async () => {
    box.create('d/s/x', ENC.encode('x\n'))
    const ws = await workspace()
    expect(await run(ws, 'rm -r /box/d; ls /box')).toEqual([0, 'f\ng\n', ''])
  })

  it('refuses cp onto a changed destination', async () => {
    const ws = await workspace()
    await run(ws, 'cat /box/g')
    box.write('g', ENC.encode('theirs\n'))
    expect(await run(ws, 'cp /box/f /box/g')).toEqual([1, '', refusal('cp')])
    expect(text(box, 'g')).toBe('theirs\n')
  })

  it.each([
    ['mv', 'update'],
    ['cp', 'copy'],
  ])('%s stays refused on a destination recreated after its clear', async (verb, route) => {
    const ws = await workspace()
    await run(ws, 'cat /box/g')
    box.hooks.set(route, () => {
      box.create('g', ENC.encode('new\n'))
    })
    expect(await run(ws, `${verb} /box/f /box/g`)).toEqual([1, '', refusal(verb)])
    expect(box.count('delete')).toBe(1)
    expect(await run(ws, `${verb} /box/f /box/g`)).toEqual([1, '', refusal(verb)])
    expect(box.count('delete')).toBe(1)
    expect(text(box, 'g')).toBe('new\n')
    expect(await run(ws, 'echo x > /box/f')).toEqual([0, '', ''])
  })

  it('sends as many requests conditioned as plain', async () => {
    const counts: number[] = []
    for (const policy of [WritePolicy.UNCONDITIONAL, WritePolicy.CONDITIONAL]) {
      const ws = await workspace(policy)
      await run(ws, 'cat /box/f')
      const before = box.log.length
      await run(ws, 'echo mine > /box/f')
      counts.push(box.log.length - before)
      box.write('f', ENC.encode(SEED.f ?? ''))
    }
    expect(counts[0]).toBe(counts[1])
  })

  it.each(['cp', 'mv'])('refuses once %s onto a destination gone since its read', async (verb) => {
    const ws = await workspace()
    await run(ws, 'cat /box/g')
    box.delete('g', 'purge')
    expect(await run(ws, `${verb} /box/f /box/g`)).toEqual([1, '', refusal(verb)])
    expect([text(box, 'f'), text(box, 'g')]).toEqual(['one\n', undefined])
    expect(await run(ws, `${verb} /box/f /box/g`)).toEqual([0, '', ''])
    expect(text(box, 'g')).toBe('one\n')
  })

  it.each(['cp', 'mv'])('lets the line write after %s onto a read file', async (verb) => {
    const ws = await workspace()
    const line = `cat /box/g > /dev/null; ${verb} /box/f /box/g; echo x > /box/g`
    expect(await run(ws, line)).toEqual([0, '', ''])
    expect(text(box, 'g')).toBe('x\n')
  })

  it('lets the line write after rm -r', async () => {
    const ws = await workspace()
    const line = 'cat /box/d/a >/dev/null; rm -r /box/d; mkdir /box/d; echo x > /box/d/a'
    expect(await run(ws, line)).toEqual([0, '', ''])
    expect(text(box, 'd/a')).toBe('x\n')
  })

  it('lets the next write through after a folder merge', async () => {
    box.create('e/d/a', ENC.encode('old\n'))
    const ws = await workspace()
    const line = 'cat /box/e/d/a >/dev/null; cp -r /box/d /box/e; echo y > /box/e/d/a'
    expect(await run(ws, line)).toEqual([0, '', ''])
    expect(await run(ws, 'echo z > /box/e/d/a')).toEqual([0, '', ''])
    expect(text(box, 'e/d/a')).toBe('z\n')
  })

  it('rm -r removes a folder holding a web link', async () => {
    box.createLink('d/bookmark')
    const ws = await workspace()
    expect(await run(ws, 'rm -r /box/d; ls /box')).toEqual([0, 'f\ng\n', ''])
  })

  it("rm -r stopped partway keeps the changed file's version", async () => {
    for (const key of ['d/a', 'd/b']) box.delete(key, 'purge')
    box.create('d/s/x', ENC.encode('x\n'))
    box.create('d/t/y', ENC.encode('y\n'))
    const ws = await workspace()
    await run(ws, 'cat /box/d/s/x')
    box.write('d/s/x', ENC.encode('theirs\n'))
    box.hooks.set('delete', () => {
      box.create('d/t/late', ENC.encode('late\n'))
    })
    const [code, , err] = await run(ws, 'rm -r /box/d')
    expect(code).toBe(1)
    expect(err).toContain('Directory not empty')
    expect(await run(ws, 'echo z > /box/d/s/x')).toEqual([1, '', `/box/d/s/x: ${STALE}\n`])
    expect(text(box, 'd/s/x')).toBe('theirs\n')
  })

  it('resizing holds the bytes it downloaded', async () => {
    const ws = await workspace()
    await run(ws, 'cat /box/f')
    box.hooks.set('content', () => {
      box.write('f', ENC.encode('theirs\n'))
    })
    expect(await run(ws, 'truncate -s 3 /box/f')).toEqual([0, '', ''])
    expect(text(box, 'f')).toBe('the')
  })

  it('rm -r keeps a file changed during the walk', async () => {
    const ws = await workspace()
    box.hooks.set('delete', () => {
      box.write('d/b', ENC.encode('theirs\n'))
    })
    expect(await run(ws, 'rm -r /box/d')).toEqual([
      1,
      '',
      `rm: cannot remove '/box/d/b': ${STALE}\n`,
    ])
    expect([text(box, 'd/a'), text(box, 'd/b')]).toEqual([undefined, 'theirs\n'])
  })

  it.each(['cp', 'mv'])('refuses %s onto a destination changed during its clear', async (verb) => {
    const ws = await workspace()
    await run(ws, 'cat /box/g')
    box.hooks.set('delete', () => {
      box.write('g', ENC.encode('theirs\n'))
    })
    expect(await run(ws, `${verb} /box/f /box/g`)).toEqual([1, '', refusal(verb)])
    expect([text(box, 'f'), text(box, 'g')]).toEqual(['one\n', 'theirs\n'])
  })

  it.each([
    ['mv away', 'mv /box/g /box/h', 'g'],
    ['mv of an ancestor', 'mv /box/d /box/e; mkdir /box/d', 'd/a'],
  ])('a move lifts a kept version: %s', async (_name, line, key) => {
    const ws = await workspace()
    await run(ws, `cat /box/${key}`)
    box.write(key, ENC.encode('theirs\n'))
    const refusedThenMoved = `echo x > /box/${key}; ${line}; echo new > /box/${key}`
    expect(await run(ws, refusedThenMoved)).toEqual([0, '', `/box/${key}: ${STALE}\n`])
    expect(text(box, key)).toBe('new\n')
  })

  it.each([
    ['unconditional', WritePolicy.UNCONDITIONAL, 1],
    ['conditional', WritePolicy.CONDITIONAL, 0],
  ])('an empty resize reads only where writes go plain: %s', async (_name, policy, downloads) => {
    const ws = await workspace(policy)
    expect(await run(ws, 'truncate -s 0 /box/f')).toEqual([0, '', ''])
    expect(box.count('content')).toBe(downloads)
    expect(text(box, 'f')).toBe('')
  })

  it('rm -r skips a web link already gone', async () => {
    box.createLink('d/bookmark')
    box.hooks.set('delete', () => {
      box.delete('d/bookmark', 'purge')
    })
    const ws = await workspace()
    expect(await run(ws, 'rm -r /box/d; ls /box')).toEqual([0, 'f\ng\n', ''])
  })

  it('rm -r reports a web link it may not delete', async () => {
    const link = box.createLink('d/bookmark')
    box.forbidden.add(link)
    const ws = await workspace()
    const denied = `${box.url}/2.0/web_links/${link} → 403 {"code":"forbidden"}`
    expect(await run(ws, 'rm -r /box/d')).toEqual([1, '', `rm: Box DELETE ${denied}\n`])
    expect(await run(ws, 'ls /box')).toEqual([0, 'd\nf\ng\n', ''])
  })

  it('rm -r names the first changed file and keeps both', async () => {
    const ws = await workspace()
    await run(ws, 'cat /box/d/a /box/d/b')
    box.write('d/a', ENC.encode('theirs\n'))
    box.write('d/b', ENC.encode('theirs\n'))
    expect(await run(ws, 'rm -r /box/d')).toEqual([
      1,
      '',
      `rm: cannot remove '/box/d/a': ${STALE}\n`,
    ])
    expect(await run(ws, 'echo x > /box/d/b')).toEqual([1, '', `/box/d/b: ${STALE}\n`])
  })

  it.each([
    ['cp', 'copy', 'folder'],
    ['mv', 'update', 'folder'],
    ['cp', 'copy', 'web link'],
    ['mv', 'update', 'web link'],
  ])(
    "keeps no version when %s's destination is retaken after its clear (%s, by a %s)",
    async (verb, route, taker) => {
      const ws = await workspace()
      await run(ws, 'cat /box/g')
      box.hooks.set('delete', () => {
        box.hooks.set(route, () => {
          if (taker === 'folder') box.create('g/x', ENC.encode('x\n'))
          else box.createLink('g')
        })
      })
      expect(await run(ws, `${verb} /box/f /box/g`)).toEqual([1, '', refusal(verb)])
      box.delete('g', 'purge')
      expect(await run(ws, 'echo y > /box/g')).toEqual([0, '', ''])
    },
  )
})
