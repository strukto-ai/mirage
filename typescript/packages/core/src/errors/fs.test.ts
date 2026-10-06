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
import {
  eacces,
  eaccesRefused,
  efbig,
  eloop,
  erofsReadOnly,
  enoent,
  enotsup,
  enotdir,
  enotempty,
  exdev,
  fsStrerror,
  isFsError,
  isMissingPath,
  noMount,
  listingError,
  readdirError,
  isDotWalkError,
  walkRefusal,
} from './fs.ts'
import { formatFsError, fsErrorLine } from './render.ts'
import { PathSpec } from '../types.ts'

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
const DEC = new TextDecoder()

describe('enotsup', () => {
  it('carries the op and the operand', () => {
    const err = enotsup('email', 'unlink', '/mail/inbox/a.txt')
    expect(err.code).toBe('ENOTSUP')
    expect(err.op).toBe('unlink')
    expect(err.virtualPath).toBe('/mail/inbox/a.txt')
    expect(err.message).toContain('no op registered: unlink')
  })

  it('is a recognized fs error with its strerror text', () => {
    const err = enotsup('email', 'unlink', '/mail/a.txt')
    expect(isFsError(err)).toBe(true)
    expect(fsStrerror(err)).toBe('Operation not supported')
  })

  it('formats as an operand line at the chokepoint', () => {
    const line = formatFsError('mv', enotsup('email', 'unlink', '/mail/a.txt'))
    expect(DEC.decode(line)).toBe('mv: /mail/a.txt: Operation not supported\n')
  })
})

describe('efbig', () => {
  it('is a per-operand fs error that formats as File too large', () => {
    const err = efbig({ virtual: '/at/records.jsonl' })
    expect(err.code).toBe('EFBIG')
    expect(err.virtualPath).toBe('/at/records.jsonl')
    expect(isFsError(err)).toBe(true)
    expect(DEC.decode(formatFsError('cat', err))).toBe('cat: /at/records.jsonl: File too large\n')
  })
})

describe('erofsReadOnly', () => {
  it('keeps the read-only message while stamping EROFS and the operand', () => {
    const err = erofsReadOnly("mount '/mail/' is read-only", '/mail/a.txt')
    expect(err.code).toBe('EROFS')
    expect(err.virtualPath).toBe('/mail/a.txt')
    expect(err.message).toContain('read-only')
    expect(fsStrerror(err)).toBe('Read-only file system')
  })
})

describe('eaccesRefused', () => {
  it('carries a caller message while stamping EACCES and the operand', () => {
    const err = eaccesRefused('S3 refused to delete 2 source object(s)', '/mail/a.txt')
    expect(err.code).toBe('EACCES')
    expect(err.virtualPath).toBe('/mail/a.txt')
    expect(fsStrerror(err)).toBe('Permission denied')
  })
})

describe('noMount', () => {
  it('keeps the Python message text and carries no POSIX code', () => {
    const err = noMount('/nowhere/x')
    expect(err.message).toBe('no mount matches path: /nowhere/x')
    expect(isFsError(err)).toBe(false)
    expect(fsStrerror(err)).toBeNull()
  })
})

describe('isMissingPath', () => {
  it('accepts the two Python swallows: FileNotFoundError and the no-mount ValueError', () => {
    expect(isMissingPath(enoent('/x'))).toBe(true)
    expect(isMissingPath(noMount('/nowhere/x'))).toBe(true)
  })

  it('rejects every other failure, including other fs errors', () => {
    expect(isMissingPath(eacces('/x'))).toBe(false)
    expect(isMissingPath(enotdir('/x'))).toBe(false)
    expect(isMissingPath(enotsup('email', 'stat', '/mail/a.txt'))).toBe(false)
    expect(isMissingPath(new Error('401 Unauthorized'))).toBe(false)
    expect(isMissingPath(undefined)).toBe(false)
  })
})

describe('fsStrerror', () => {
  it('maps recognized codes and returns null otherwise', () => {
    expect(fsStrerror(enoent('/x'))).toBe('No such file or directory')
    expect(fsStrerror(eacces('/x'))).toBe('Permission denied')
    expect(fsStrerror(new Error('nope'))).toBeNull()
  })

  it('reads a condition that has no class of its own', () => {
    expect(fsStrerror(enotempty('/d'))).toBe('Directory not empty')
    expect(fsStrerror(exdev('/d'))).toBe('Invalid cross-device link')
    expect(fsStrerror(Object.assign(new Error('x'), { code: 'EIO' }))).toBeNull()
    expect(fsStrerror(null)).toBeNull()
  })
})

describe('readdirError', () => {
  const isFile = (key: string): boolean => key === '/data/a.txt'
  const isDir = (key: string): boolean => key === '/data' || key === '/data/sub'

  it('reports ENOENT for a path that does not exist', async () => {
    const err = await readdirError('/data/nope', '/data/nope', isFile, isDir)
    expect(err.code).toBe('ENOENT')
    expect(fsStrerror(err)).toBe('No such file or directory')
  })

  it('stays ENOENT however deep the missing component is', async () => {
    // `ls /data/nope/deeper` reports the missing component, not ENOTDIR.
    const err = await readdirError('/data/nope/deeper', '/data/nope/deeper', isFile, isDir)
    expect(err.code).toBe('ENOENT')
  })

  it('reports ENOTDIR when a path component is a file', async () => {
    for (const key of ['/data/a.txt', '/data/a.txt/x', '/data/a.txt/x/y']) {
      const err = await readdirError(key, key, isFile, isDir)
      expect(err.code, key).toBe('ENOTDIR')
      expect(fsStrerror(err)).toBe('Not a directory')
    }
  })

  it('stops at the first missing component instead of an orphan below it', async () => {
    // A flat store can hold a key under a parent that is not a directory
    // (RAM/Redis rename does not create the destination's ancestors). The
    // walk must stop where the kernel would, at /data/missing.
    const orphanFile = (key: string): boolean => key === '/data/missing/a.txt'
    const orphanDir = (key: string): boolean => key === '/data'
    for (const key of ['/data/missing/a.txt/x', '/data/missing/a.txt/x/y']) {
      const err = await readdirError(key, key, orphanFile, orphanDir)
      expect(err.code, key).toBe('ENOENT')
    }
  })

  it('prefers a coexisting directory over the object of the same name', async () => {
    // A keyed store can hold an object `a` and a prefix `a/` at once, and a
    // child path only ever reaches `a` through the directory. So the
    // directory wins: /data/a/never is ENOENT because `never` is absent, not
    // ENOTDIR because `a` is also an object.
    const bothFile = (key: string): boolean => key === '/data/a' || key === '/data/a/x'
    const bothDir = (key: string): boolean => key === '/data' || key === '/data/a'
    for (const key of ['/data/a/never', '/data/a/never/deeper']) {
      const err = await readdirError(key, key, bothFile, bothDir)
      expect(err.code, key).toBe('ENOENT')
    }
  })

  it('still reports ENOTDIR when no directory coexists', async () => {
    const err = await readdirError('/data/a.txt/never', '/data/a.txt/never', isFile, isDir)
    expect(err.code).toBe('ENOTDIR')
  })

  it('reports ENOENT for an orphan exact file rather than shortcutting', async () => {
    // A flat store can hold `/data/missing/a.txt` with `/data/missing` absent,
    // and resolution stops at the gap: readdir of the orphan itself is ENOENT,
    // not ENOTDIR, exactly as it already is one level below. listingError is
    // where the shortcut lives, for the stores that cannot hold the gap.
    const orphanFile = (key: string): boolean => key === '/data/missing/a.txt'
    const orphanDir = (key: string): boolean => key === '/data'
    const err = await readdirError(
      '/data/missing/a.txt',
      '/data/missing/a.txt',
      orphanFile,
      orphanDir,
    )
    expect(err.code).toBe('ENOENT')
  })

  it('accepts an async probe and stamps the operand spelling', async () => {
    const err = await readdirError(
      { virtual: '/data/nope', rawPath: 'nope' },
      '/data/nope',
      (key) => Promise.resolve(isFile(key)),
      (key) => Promise.resolve(isDir(key)),
    )
    expect(err.code).toBe('ENOENT')
    expect(err.virtualPath).toBe('nope')
  })
})

describe('listingError', () => {
  const isFile = (key: string): boolean => key === '/data/a.txt'
  const isDir = (key: string): boolean => key === '/data' || key === '/data/sub'

  it('settles a file operand in one probe, without walking its ancestors', async () => {
    // A store that cannot hold an orphan proves ENOTDIR outright. That is what
    // keeps a readdir on a plain file to one round trip on an API-backed mount,
    // where each probe is a request.
    const probed: string[] = []
    const countingIsFile = (key: string): boolean => {
      probed.push(key)
      return key === '/data/deep/a.txt'
    }
    const unreachableIsDir = (key: string): boolean => {
      throw new Error(`the walk should not have started: ${key}`)
    }
    const err = await listingError(
      '/data/deep/a.txt',
      '/data/deep/a.txt',
      countingIsFile,
      unreachableIsDir,
    )
    expect(err.code).toBe('ENOTDIR')
    expect(probed).toEqual(['/data/deep/a.txt'])
  })

  it('falls back to the walk for anything the first probe does not settle', async () => {
    expect((await listingError('/data/a.txt/never', '/data/a.txt/never', isFile, isDir)).code).toBe(
      'ENOTDIR',
    )
    expect((await listingError('/data/nope/deeper', '/data/nope/deeper', isFile, isDir)).code).toBe(
      'ENOENT',
    )
  })

  it('asks the listed path whether it is a file once', async () => {
    // The walk ends at the listed path, which the first probe already found
    // is not a file; on an API-backed mount a second ask is a second request.
    const asked: string[] = []
    const countingIsFile = (key: string): boolean => {
      asked.push(key)
      return isFile(key)
    }
    const err = await listingError('/data/sub/never', '/data/sub/never', countingIsFile, isDir)
    expect(err.code).toBe('ENOENT')
    expect(asked).toEqual(['/data/sub/never'])
  })

  it('asks the mount root nothing', async () => {
    const unreachable = (key: string): boolean => {
      throw new Error(`the root needs no probe: ${key}`)
    }
    const err = await listingError('/', '/', unreachable, unreachable)
    expect(err.code).toBe('ENOENT')
  })
})

it.each(['head', 'tail'])('%s names a read-cap failure at the chokepoint', (cmd) => {
  expect(decode(formatFsError(cmd, efbig('/records.jsonl')))).toBe(
    `${cmd}: error reading '/records.jsonl': File too large\n`,
  )
})

describe('walkRefusal', () => {
  it('names the empty operand as typed, not as the cwd it reads as', () => {
    const spec = new PathSpec({
      virtual: '/data',
      directory: '/',
      vfsPath: '',
      rawPath: '',
      walkError: 'ENOENT',
    })
    const err = walkRefusal(spec)
    expect(isDotWalkError(err)).toBe(true)
    expect(fsErrorLine('cat', spec, err)).toBe("cat: '': No such file or directory\n")
  })

  it('refuses a loop as a final per-operand error', () => {
    const spec = new PathSpec({
      virtual: '/data/l1',
      directory: '/data/',
      vfsPath: 'l1',
      rawPath: 'l1',
      walkError: 'ELOOP',
    })
    const err = walkRefusal(spec)
    expect(isDotWalkError(err)).toBe(true)
    expect(isFsError(err)).toBe(true)
    expect(fsErrorLine('head', spec, err)).toBe(
      "head: cannot open 'l1' for reading: Too many levels of symbolic links\n",
    )
  })

  it('types eloop as a walk refusal', () => {
    const err = eloop('/data/l1')
    expect(isDotWalkError(err)).toBe(true)
    expect(fsStrerror(err)).toBe('Too many levels of symbolic links')
  })

  it.each(['wc', 'du'])('%s vets the empty name', (cmd) => {
    expect(fsErrorLine(cmd, '', enoent(''))).toBe(`${cmd}: invalid zero-length file name\n`)
  })

  it('quotes the empty operand for everything else', () => {
    expect(fsErrorLine('tail', '', enoent(''))).toBe(
      "tail: cannot open '' for reading: No such file or directory\n",
    )
  })
})
