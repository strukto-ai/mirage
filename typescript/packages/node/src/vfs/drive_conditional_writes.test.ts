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
import { InlineDropbox } from './fixtures/dropbox.ts'
import { buildVfs } from './registry.ts'

const STALE = 'changed since it was read; read it again before writing'
const ENC = new TextEncoder()
const DEC = new TextDecoder()
const SEED: Record<string, string> = { f: 'one\n', g: 'gee\n', 'd/a': 'a\n', 'd/b': 'b\n' }
const DROPBOX_CONFIG = { client_id: 'i', client_secret: 's', refresh_token: 'r' }

type Kind = 'box' | 'dropbox'

class Drive {
  readonly fake: InlineBox | InlineDropbox
  readonly root: string
  readonly move: string
  readonly download: string

  constructor(readonly kind: Kind) {
    const files = Object.fromEntries(Object.entries(SEED).map(([k, v]) => [k, ENC.encode(v)]))
    const box = kind === 'box'
    this.fake = box ? new InlineBox(files) : new InlineDropbox(files)
    this.root = box ? '/box' : '/dbx'
    this.move = box ? 'update' : 'move'
    this.download = box ? 'content' : 'download'
  }

  get box(): InlineBox {
    if (!(this.fake instanceof InlineBox)) throw new Error('not a Box drive')
    return this.fake
  }

  get dropbox(): InlineDropbox {
    if (!(this.fake instanceof InlineDropbox)) throw new Error('not a Dropbox drive')
    return this.fake
  }

  config(): Record<string, string> {
    return this.kind === 'box'
      ? { access_token: 't', endpoint: this.fake.url }
      : { ...DROPBOX_CONFIG, endpoint: this.fake.url }
  }

  put(key: string, data: string): void {
    if (this.fake instanceof InlineBox && this.fake.read(key) === undefined) {
      this.fake.create(key, ENC.encode(data))
    } else this.fake.write(key, ENC.encode(data))
  }

  drop(key: string): void {
    if (this.fake instanceof InlineBox) this.fake.delete(key, 'purge')
    else this.fake.delete(key)
  }

  text(key: string): string | undefined {
    const data = this.fake.read(key)
    return data === undefined ? undefined : DEC.decode(data)
  }

  hook(route: string, fn: () => void): void {
    this.fake.hooks.set(route, fn)
  }
}

let drive: Drive
const built: Workspace[] = []

async function workspace(write: WritePolicy = WritePolicy.CONDITIONAL): Promise<Workspace> {
  const vfs = await buildVfs(drive.kind, drive.config())
  const ws = new Workspace({ [drive.root]: new Mount(vfs, { mode: MountMode.WRITE, write }) })
  built.push(ws)
  return ws
}

function use(kind: Kind): void {
  beforeEach(() => {
    drive = new Drive(kind)
    vi.stubGlobal('fetch', drive.fake.fetch)
  })
  afterEach(async () => {
    for (const ws of built.splice(0)) await ws.close()
    vi.unstubAllGlobals()
  })
}

async function run(ws: Workspace, line: string): Promise<[number, string, string]> {
  const r = await ws.shell(line)
  return [r.exitCode, DEC.decode(r.stdout), DEC.decode(r.stderr)]
}

function refusal(verb: string): string {
  const r = drive.root
  if (verb === 'cp') return `cp: cannot create regular file '${r}/g': ${STALE}\n`
  return `mv: cannot move '${r}/f' to '${r}/g': '${r}/g' ${STALE}\n`
}

function fail(): never {
  throw new Error('injected server error')
}

describe.each(['box', 'dropbox'] as const)('conditional writes on %s', (kind) => {
  use(kind)

  it('refuses a changed file before any upload', async () => {
    const r = drive.root
    const ws = await workspace()
    await run(ws, `cat ${r}/f`)
    drive.put('f', 'theirs\n')
    const uploads = drive.fake.count('upload')
    expect(await run(ws, `echo mine > ${r}/f`)).toEqual([1, '', `${r}/f: ${STALE}\n`])
    expect(drive.fake.count('upload')).toBe(uploads)
    expect(drive.text('f')).toBe('theirs\n')
  })

  it('refuses a write landing after the lookup', async () => {
    const r = drive.root
    const ws = await workspace()
    await run(ws, `cat ${r}/f`)
    drive.hook('upload', () => {
      drive.put('f', 'theirs\n')
    })
    expect(await run(ws, `echo mine > ${r}/f`)).toEqual([1, '', `${r}/f: ${STALE}\n`])
    expect(drive.text('f')).toBe('theirs\n')
  })

  it.each(['echo x >> {r}/f', 'truncate -s 2 {r}/f'])(
    'carries the version of its own read: %s',
    async (line) => {
      const ws = await workspace()
      drive.hook('upload', () => {
        drive.put('f', 'theirs\n')
      })
      const [code, , err] = await run(ws, line.replace('{r}', drive.root))
      expect(code).toBe(1)
      expect(err).toContain(STALE)
      expect(drive.text('f')).toBe('theirs\n')
    },
  )

  it.each([
    ['unconditional', WritePolicy.UNCONDITIONAL],
    ['conditional', WritePolicy.CONDITIONAL],
  ])('an empty resize reads nothing: %s', async (_name, policy) => {
    const ws = await workspace(policy)
    expect(await run(ws, `truncate -s 0 ${drive.root}/f`)).toEqual([0, '', ''])
    expect(drive.fake.count(drive.download)).toBe(0)
    expect(drive.text('f')).toBe('')
  })

  it('a streamed ops read through an outdated listing holds its bytes', async () => {
    const r = drive.root
    const ws = await workspace()
    await ws.vfs.readdir(r)
    drive.put('f', 'B\n')
    const chunks: Uint8Array[] = []
    for await (const chunk of await ws.vfs.readStream(`${r}/f`)) chunks.push(chunk)
    expect(chunks.map((c) => DEC.decode(c)).join('')).toBe('B\n')
    drive.put('f', 'C\n')
    await expect(ws.vfs.write(`${r}/f`, ENC.encode('mine\n'))).rejects.toMatchObject({
      code: 'STALE_WRITE',
    })
    expect(drive.text('f')).toBe('C\n')
  })

  it('pins rm of an unread file to its lookup', async () => {
    const r = drive.root
    const ws = await workspace()
    drive.hook('delete', () => {
      drive.put('f', 'theirs\n')
    })
    expect(await run(ws, `rm ${r}/f`)).toEqual([1, '', `rm: cannot remove '${r}/f': ${STALE}\n`])
    expect(drive.text('f')).toBe('theirs\n')
  })

  it('rm -r removes an unchanged folder', async () => {
    drive.put('d/s/x', 'x\n')
    const ws = await workspace()
    expect(await run(ws, `rm -r ${drive.root}/d; ls ${drive.root}`)).toEqual([0, 'f\ng\n', ''])
  })

  it('lets the line write after rm -r', async () => {
    const r = drive.root
    const ws = await workspace()
    const mkdir = drive.kind === 'box' ? ` mkdir ${r}/d;` : ''
    const line = `cat ${r}/d/a > /dev/null; rm -r ${r}/d;${mkdir} echo x > ${r}/d/a`
    expect(await run(ws, line)).toEqual([0, '', ''])
    expect(drive.text('d/a')).toBe('x\n')
  })

  it('rm -r keeps a file changed during the walk', async () => {
    const r = drive.root
    const ws = await workspace()
    drive.hook('delete', () => {
      drive.put('d/b', 'theirs\n')
    })
    expect(await run(ws, `rm -r ${r}/d`)).toEqual([
      1,
      '',
      `rm: cannot remove '${r}/d/b': ${STALE}\n`,
    ])
    expect([drive.text('d/a'), drive.text('d/b')]).toEqual([undefined, 'theirs\n'])
  })

  it('rm -r names the first changed file and keeps both', async () => {
    const r = drive.root
    const ws = await workspace()
    await run(ws, `cat ${r}/d/a ${r}/d/b`)
    drive.put('d/a', 'theirs\n')
    drive.put('d/b', 'theirs\n')
    expect(await run(ws, `rm -r ${r}/d`)).toEqual([
      1,
      '',
      `rm: cannot remove '${r}/d/a': ${STALE}\n`,
    ])
    expect(await run(ws, `echo x > ${r}/d/b`)).toEqual([1, '', `${r}/d/b: ${STALE}\n`])
  })

  it("rm -r stopped partway keeps the changed file's version", async () => {
    const r = drive.root
    for (const key of ['d/a', 'd/b']) drive.drop(key)
    drive.put('d/s/x', 'x\n')
    drive.put('d/t/y', 'y\n')
    const ws = await workspace()
    await run(ws, `cat ${r}/d/s/x`)
    drive.put('d/s/x', 'theirs\n')
    drive.hook('delete', () => {
      drive.put('d/t/late', 'late\n')
    })
    const [code, , err] = await run(ws, `rm -r ${r}/d`)
    expect(code).toBe(1)
    expect(err).toContain('Directory not empty')
    expect(await run(ws, `echo z > ${r}/d/s/x`)).toEqual([1, '', `${r}/d/s/x: ${STALE}\n`])
    expect(drive.text('d/s/x')).toBe('theirs\n')
  })

  it.each(['cp', 'mv'])('refuses %s onto a destination changed during its clear', async (verb) => {
    const r = drive.root
    const ws = await workspace()
    await run(ws, `cat ${r}/g`)
    drive.hook('delete', () => {
      drive.put('g', 'theirs\n')
    })
    expect(await run(ws, `${verb} ${r}/f ${r}/g`)).toEqual([1, '', refusal(verb)])
    expect([drive.text('f'), drive.text('g')]).toEqual(['one\n', 'theirs\n'])
  })

  it.each(['cp', 'mv'])(
    '%s stays refused on a destination recreated after its clear',
    async (verb) => {
      const r = drive.root
      const ws = await workspace()
      await run(ws, `cat ${r}/g`)
      const route = verb === 'cp' ? 'copy' : drive.move
      drive.hook('delete', () => {
        drive.hook(route, () => {
          drive.put('g', 'new\n')
        })
      })
      for (let i = 0; i < 2; i++) {
        expect(await run(ws, `${verb} ${r}/f ${r}/g`)).toEqual([1, '', refusal(verb)])
        expect(drive.fake.count('delete')).toBe(1)
      }
      expect(drive.text('g')).toBe('new\n')
      expect(await run(ws, `echo x > ${r}/f`)).toEqual([0, '', ''])
    },
  )

  it.each(['cp', 'mv'])(
    "keeps no version when a folder retakes %s's destination after its clear",
    async (verb) => {
      const r = drive.root
      const ws = await workspace()
      await run(ws, `cat ${r}/g`)
      const route = verb === 'cp' ? 'copy' : drive.move
      drive.hook('delete', () => {
        drive.hook(route, () => {
          drive.put('g/x', 'x\n')
        })
      })
      expect(await run(ws, `${verb} ${r}/f ${r}/g`)).toEqual([1, '', refusal(verb)])
      drive.drop('g')
      expect(await run(ws, `echo y > ${r}/g`)).toEqual([0, '', ''])
    },
  )

  it.each(['cp', 'mv'])('refuses once %s onto a destination gone since its read', async (verb) => {
    const r = drive.root
    const ws = await workspace()
    await run(ws, `cat ${r}/g`)
    drive.drop('g')
    expect(await run(ws, `${verb} ${r}/f ${r}/g`)).toEqual([1, '', refusal(verb)])
    expect([drive.text('f'), drive.text('g')]).toEqual(['one\n', undefined])
    expect(await run(ws, `${verb} ${r}/f ${r}/g`)).toEqual([0, '', ''])
    expect(drive.text('g')).toBe('one\n')
  })

  it.each(['cp', 'mv'])('lets the line write after %s onto a read file', async (verb) => {
    const r = drive.root
    const ws = await workspace()
    const line = `cat ${r}/g > /dev/null; ${verb} ${r}/f ${r}/g; echo x > ${r}/g`
    expect(await run(ws, line)).toEqual([0, '', ''])
    expect(drive.text('g')).toBe('x\n')
  })

  it.each([
    ['file', false],
    ['ancestor', true],
  ])('a move lifts a kept version: %s', async (_name, ancestor) => {
    const r = drive.root
    let key = 'g'
    let move = `mv ${r}/g ${r}/h`
    if (ancestor) {
      key = 'd/a'
      move = `mv ${r}/d ${r}/e` + (drive.kind === 'box' ? `; mkdir ${r}/d` : '')
    }
    const ws = await workspace()
    await run(ws, `cat ${r}/${key}`)
    drive.put(key, 'theirs\n')
    const line = `echo x > ${r}/${key}; ${move}; echo new > ${r}/${key}`
    expect(await run(ws, line)).toEqual([0, '', `${r}/${key}: ${STALE}\n`])
    expect(drive.text(key)).toBe('new\n')
  })
})

describe('conditional writes only Box has', () => {
  use('box')

  it('sends as many requests conditioned as plain', async () => {
    const counts: number[] = []
    for (const policy of [WritePolicy.UNCONDITIONAL, WritePolicy.CONDITIONAL]) {
      const ws = await workspace(policy)
      await run(ws, 'cat /box/f')
      const before = drive.box.log.length
      await run(ws, 'echo mine > /box/f')
      counts.push(drive.box.log.length - before)
      drive.put('f', SEED.f ?? '')
    }
    expect(counts[0]).toBe(counts[1])
  })

  it('resizing holds the bytes it downloaded', async () => {
    const ws = await workspace()
    await run(ws, 'cat /box/f')
    drive.hook('content', () => {
      drive.put('f', 'theirs\n')
    })
    expect(await run(ws, 'truncate -s 3 /box/f')).toEqual([0, '', ''])
    expect(drive.text('f')).toBe('the')
  })

  it('resizing a file Box keeps no sha1 for goes out plain', async () => {
    drive.box.unhashed.add(drive.box.idOf('f'))
    const ws = await workspace()
    expect(await run(ws, 'truncate -s 2 /box/f')).toEqual([0, '', ''])
    expect(drive.text('f')).toBe('on')
  })

  it('lets the next write through after a folder merge', async () => {
    drive.put('e/d/a', 'old\n')
    const ws = await workspace()
    const line = 'cat /box/e/d/a >/dev/null; cp -r /box/d /box/e; echo y > /box/e/d/a'
    expect(await run(ws, line)).toEqual([0, '', ''])
    expect(await run(ws, 'echo z > /box/e/d/a')).toEqual([0, '', ''])
    expect(drive.text('e/d/a')).toBe('z\n')
  })

  it('a folder merge keeps the versions of files it left', async () => {
    drive.put('e/d/a', 'new\n')
    const ws = await workspace()
    await run(ws, 'cat /box/d/b')
    expect(await run(ws, 'cp -r /box/e/d /box')).toEqual([0, '', ''])
    drive.put('d/b', 'theirs\n')
    expect(await run(ws, 'echo mine > /box/d/b')).toEqual([1, '', `/box/d/b: ${STALE}\n`])
    expect(drive.text('d/b')).toBe('theirs\n')
  })

  it('a folder copied whole lifts the lost marks beneath it', async () => {
    drive.put('s/a', 'new\n')
    drive.hook('upload', () => {
      drive.put('d/a', 'theirs\n')
      drive.hook('upload', () => {
        drive.drop('d')
      })
    })
    const ws = await workspace()
    const line =
      'cat /box/d/a > /dev/null; echo x > /box/d/a; echo y > /box/y; ' +
      'cp -r /box/s /box/d && echo mine > /box/d/a'
    expect(await run(ws, line)).toEqual([0, '', `/box/d/a: ${STALE}\n`])
    expect(drive.text('d/a')).toBe('mine\n')
  })

  it('a folder copy that failed keeps the versions beneath it', async () => {
    drive.put('s/a', 'new\n')
    drive.hook('upload', () => {
      drive.drop('d')
    })
    drive.hook('copy', () => {
      drive.put('d/a', 'theirs\n')
      fail()
    })
    const ws = await workspace()
    const line =
      'cat /box/d/a > /dev/null; echo z > /box/z; ' +
      'cp -r /box/s /box/d; ls /box/d; echo mine > /box/d/a'
    const [code, out, err] = await run(ws, line)
    expect([code, out]).toEqual([1, 'a\n'])
    expect(err.endsWith(`/box/d/a: ${STALE}\n`)).toBe(true)
    expect(drive.text('d/a')).toBe('theirs\n')
  })

  it.each([
    ['link gone', true],
    ['link kept', false],
  ])('rm -r deletes a web link plainly: %s', async (_name, gone) => {
    drive.box.createLink('d/bookmark')
    if (gone)
      drive.hook('delete', () => {
        drive.drop('d/bookmark')
      })
    const ws = await workspace()
    expect(await run(ws, 'rm -r /box/d; ls /box')).toEqual([0, 'f\ng\n', ''])
  })

  it('rm -r reports a web link it may not delete', async () => {
    const link = drive.box.createLink('d/bookmark')
    drive.box.forbidden.add(link)
    const ws = await workspace()
    const denied = `${drive.box.url}/2.0/web_links/${link} → 403 {"code":"forbidden"}`
    expect(await run(ws, 'rm -r /box/d')).toEqual([1, '', `rm: Box DELETE ${denied}\n`])
    expect(await run(ws, 'ls /box')).toEqual([0, 'd\nf\ng\n', ''])
  })

  it.each(['cp', 'mv'])(
    "keeps no version when a web link retakes %s's destination",
    async (verb) => {
      const ws = await workspace()
      await run(ws, 'cat /box/g')
      const route = verb === 'cp' ? 'copy' : 'update'
      drive.hook('delete', () => {
        drive.hook(route, () => drive.box.createLink('g'))
      })
      expect(await run(ws, `${verb} /box/f /box/g`)).toEqual([1, '', refusal(verb)])
      drive.drop('g')
      expect(await run(ws, 'echo y > /box/g')).toEqual([0, '', ''])
    },
  )

  it.each([
    ['line', true],
    ['next line', false],
  ])('a cp that changed nothing keeps the held version: %s', async (_name, sameLine) => {
    const ws = await workspace()
    drive.hook('delete', () => {
      drive.put('g', 'theirs\n')
      fail()
    })
    let code: number
    let err: string
    if (sameLine) {
      ;[code, , err] = await run(ws, 'cat /box/g >/dev/null; cp /box/f /box/g; echo mine > /box/g')
    } else {
      await run(ws, 'cat /box/g')
      await run(ws, 'cp /box/f /box/g')
      ;[code, , err] = await run(ws, 'echo mine > /box/g')
    }
    expect(code).toBe(1)
    expect(err.endsWith(`/box/g: ${STALE}\n`)).toBe(true)
    expect(drive.text('g')).toBe('theirs\n')
  })

  it('a cp whose delete landed but failed serves no stale bytes', async () => {
    const ws = await workspace()
    await run(ws, 'cat /box/g')
    drive.hook('delete', () => {
      drive.drop('g')
      fail()
    })
    const [code] = await run(ws, 'cp /box/f /box/g')
    expect(code).toBe(1)
    const [catCode, out] = await run(ws, 'cat /box/g')
    expect([catCode, out]).toEqual([1, ''])
  })
})

describe('conditional writes only Dropbox has', () => {
  use('dropbox')

  it('costs a held write one lookup more than a plain one', async () => {
    const routes: string[][] = []
    for (const policy of [WritePolicy.UNCONDITIONAL, WritePolicy.CONDITIONAL]) {
      const ws = await workspace(policy)
      await run(ws, 'cat /dbx/f')
      const before = drive.dropbox.log.length
      await run(ws, 'echo mine > /dbx/f')
      routes.push(drive.dropbox.log.slice(before).filter((r) => r !== 'token'))
      drive.put('f', SEED.f ?? '')
    }
    expect(routes).toEqual([
      ['upload', 'upload'],
      ['get_metadata', 'upload', 'get_metadata', 'upload'],
    ])
  })

  it.each([
    ['mv', 'move'],
    ['cp', 'copy'],
  ])('%s of a vanished source costs a read destination nothing', async (verb, route) => {
    const ws = await workspace()
    await run(ws, 'ls /dbx; cat /dbx/g')
    drive.drop('f')
    const [code, , err] = await run(ws, `${verb} /dbx/f /dbx/g`)
    expect(code).toBe(1)
    expect(err).toContain('No such file or directory')
    expect(drive.fake.count(route)).toBe(1)
    expect(drive.fake.count('delete')).toBe(0)
    expect(drive.text('g')).toBe('gee\n')
  })

  it.each([
    ['cp', 'copy'],
    ['mv', 'move'],
  ])('refuses %s onto a destination a folder took, deleting nothing', async (verb, route) => {
    const ws = await workspace()
    await run(ws, 'cat /dbx/g')
    drive.hook(route, () => {
      drive.drop('g')
      drive.put('g/x', 'x\n')
    })
    expect(await run(ws, `${verb} /dbx/f /dbx/g`)).toEqual([1, '', refusal(verb)])
    expect(drive.fake.count('delete')).toBe(0)
    expect([drive.text('f'), drive.text('g/x')]).toEqual(['one\n', 'x\n'])
    drive.drop('g')
    expect(await run(ws, 'echo y > /dbx/g')).toEqual([0, '', ''])
  })

  it.each(['cp', 'mv'])('names a source gone before the retry for %s', async (verb) => {
    const ws = await workspace()
    await run(ws, 'cat /dbx/g')
    drive.hook('delete', () => {
      drive.drop('f')
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
    expect(drive.fake.count('delete')).toBe(1)
  })

  it.each([
    ['cp', 'copy'],
    ['mv', 'move'],
  ])('refuses once %s onto an unread destination retaken after its clear', async (verb, route) => {
    const ws = await workspace()
    drive.hook('delete', () => {
      drive.hook(route, () => {
        drive.put('g', 'new\n')
      })
    })
    expect(await run(ws, `${verb} /dbx/f /dbx/g`)).toEqual([1, '', refusal(verb)])
    expect(drive.text('g')).toBe('new\n')
    expect(await run(ws, `${verb} /dbx/f /dbx/g`)).toEqual([0, '', ''])
    expect(drive.text('g')).toBe('one\n')
  })
})
