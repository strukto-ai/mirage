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
import { classify } from './classify.ts'
import { OPERAND_CONDITIONS } from './constants.ts'
import {
  dotWalkError,
  eacces,
  ebadf,
  ebusy,
  eexist,
  efbig,
  eisdir,
  eloop,
  enoent,
  enotdir,
  enotempty,
  enotsup,
  erofs,
  exdev,
  fsError,
  fsStrerror,
  isDotWalkError,
  isFsError,
  isMissingPath,
  listingError,
  noMount,
  readdirError,
  staleWrite,
  walkRefusal,
} from './fs.ts'
import { posixPhrase } from './posix.ts'
import { fsErrorLine } from './render.ts'
import type { FsCondition } from './types.ts'
import { PathSpec } from '../types.ts'

describe('the constructors', () => {
  it.each([
    [enoent, 'ENOENT'],
    [enotdir, 'ENOTDIR'],
    [eisdir, 'EISDIR'],
    [eexist, 'EEXIST'],
    [eacces, 'EACCES'],
    [erofs, 'EROFS'],
    [ebadf, 'EBADF'],
    [efbig, 'EFBIG'],
    [eloop, 'ELOOP'],
    [enotempty, 'ENOTEMPTY'],
    [exdev, 'EXDEV'],
    [ebusy, 'EBUSY'],
    [staleWrite, 'STALE_WRITE'],
  ] as const)('%#: stamps the code and the operand, as fsError does', (make, code) => {
    for (const err of [make({ virtual: '/data/x' }), fsError('/data/x', code)]) {
      expect(err.code).toBe(code)
      expect(err.virtualPath).toBe('/data/x')
      expect(classify(err)).toBe(code)
      const operand = OPERAND_CONDITIONS.has(code as FsCondition)
      expect(isFsError(err)).toBe(operand)
      expect(fsStrerror(err)).toBe(operand ? posixPhrase(code) : null)
    }
  })

  it('keeps a message that names what was refused', () => {
    const err = eacces('/data/x', 'S3 refused to delete 2 source object(s)')
    expect(err.message).toBe('S3 refused to delete 2 source object(s)')
    expect(fsStrerror(err)).toBe('Permission denied')
    expect(fsStrerror(erofs('/m/a', "mount '/m/' is read-only"))).toBe('Read-only file system')
  })

  it('reads a stamped code and nothing else', () => {
    expect(fsStrerror(enoent('/x'))).toBe('No such file or directory')
    expect(fsStrerror(Object.assign(new Error('x'), { code: 'EIO' }))).toBeNull()
    expect(fsStrerror(new Error('nope'))).toBeNull()
    expect(fsStrerror(null)).toBeNull()
  })

  it('leaves a kernel ESTALE its own words', () => {
    // A real ESTALE from disk or NFS is no lost conditional write.
    const err = Object.assign(new Error('Stale file handle'), { code: 'ESTALE' })
    expect(classify(err)).toBeNull()
    expect(fsStrerror(err)).toBeNull()
  })

  it('carries the op and the operand for a missing op', () => {
    const err = enotsup('email', 'unlink', '/mail/inbox/a.txt')
    expect(err.code).toBe('ENOTSUP')
    expect(err.op).toBe('unlink')
    expect(err.virtualPath).toBe('/mail/inbox/a.txt')
    expect(err.message).toContain('no op registered: unlink')
    expect(fsStrerror(err)).toBe('Operation not supported')
  })

  it('stamps a walk refusal for each code a walk meets', () => {
    for (const code of ['ENOENT', 'ENOTDIR', 'ELOOP'] as const) {
      const err = dotWalkError('a/..', code)
      expect(isDotWalkError(err)).toBe(true)
      expect(classify(err)).toBe(code)
    }
  })
})

describe('noMount', () => {
  it('keeps the Python message text and carries no POSIX code', () => {
    const err = noMount('/nowhere/x')
    expect(err.message).toBe('no mount matches path: /nowhere/x')
    expect(isFsError(err)).toBe(false)
    expect(fsStrerror(err)).toBeNull()
  })

  it('is, with ENOENT, the only failure isMissingPath accepts', () => {
    expect(isMissingPath(enoent('/x'))).toBe(true)
    expect(isMissingPath(noMount('/nowhere/x'))).toBe(true)
    expect(isMissingPath(eacces('/x'))).toBe(false)
    expect(isMissingPath(enotdir('/x'))).toBe(false)
    expect(isMissingPath(enotsup('email', 'stat', '/mail/a.txt'))).toBe(false)
    expect(isMissingPath(new Error('401 Unauthorized'))).toBe(false)
    expect(isMissingPath(undefined)).toBe(false)
  })
})

function probes(files: string[], dirs: string[]): [(k: string) => boolean, (k: string) => boolean] {
  return [(key) => files.includes(key), (key) => dirs.includes(key)]
}

const FLAT = probes(['/data/a.txt'], ['/data', '/data/sub'])
const ORPHAN = probes(['/data/missing/a.txt'], ['/data'])
const BOTH = probes(['/data/a', '/data/a/x'], ['/data', '/data/a'])

describe('readdirError', () => {
  // A missing component is ENOENT however deep, a file component is
  // ENOTDIR, a flat store's orphan (/data/missing absent) stops the walk at
  // the gap, the orphan itself included, and a directory beside an object of
  // the same name wins, since traversal only reaches the name through it.
  it.each([
    ['/data/nope', FLAT, 'ENOENT'],
    ['/data/nope/deeper', FLAT, 'ENOENT'],
    ['/data/a.txt', FLAT, 'ENOTDIR'],
    ['/data/a.txt/x/y', FLAT, 'ENOTDIR'],
    ['/data/a.txt/never', FLAT, 'ENOTDIR'],
    ['/data/missing/a.txt', ORPHAN, 'ENOENT'],
    ['/data/missing/a.txt/x/y', ORPHAN, 'ENOENT'],
    ['/data/a/never', BOTH, 'ENOENT'],
    ['/data/a/never/deeper', BOTH, 'ENOENT'],
  ] as const)('%s is %s', async (key, [isFile, isDir], code) => {
    expect((await readdirError(key, key, isFile, isDir)).code).toBe(code)
  })

  it('accepts an async probe and stamps the operand spelling', async () => {
    const [isFile, isDir] = FLAT
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
  it('settles a file operand in one probe, without walking its ancestors', async () => {
    // A store that cannot hold an orphan proves ENOTDIR outright, which
    // keeps a readdir on a plain file to one request.
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
    const [isFile, isDir] = FLAT
    expect((await listingError('/data/a.txt/never', '/data/a.txt/never', isFile, isDir)).code).toBe(
      'ENOTDIR',
    )
    expect((await listingError('/data/nope/deeper', '/data/nope/deeper', isFile, isDir)).code).toBe(
      'ENOENT',
    )
  })

  it('asks the listed path whether it is a file once', async () => {
    const [isFile, isDir] = FLAT
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
    expect((await listingError('/', '/', unreachable, unreachable)).code).toBe('ENOENT')
  })
})

describe('walkRefusal', () => {
  // `virtual` reads the empty name as the working directory, so the refusal
  // carries the spelling the command reports.
  it.each([
    ['', 'ENOENT', 'cat', "cat: '': No such file or directory\n"],
    [
      'l1',
      'ELOOP',
      'head',
      "head: cannot open 'l1' for reading: Too many levels of symbolic links\n",
    ],
  ] as const)('names %j as typed', (raw, walkError, cmd, line) => {
    const spec = new PathSpec({
      virtual: raw === '' ? '/data' : '/data/l1',
      directory: raw === '' ? '/' : '/data/',
      vfsPath: raw,
      rawPath: raw,
      walkError,
    })
    const err = walkRefusal(spec)
    expect(isFsError(err)).toBe(true)
    expect(err.virtualPath).toBe(raw)
    expect(fsErrorLine(cmd, spec, err)).toBe(line)
  })
})
