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
  ebadfStdin,
  efbig,
  eisdir,
  eloop,
  erofsReadOnly,
  enoent,
  enotsup,
  enotdir,
  formatFsError,
  fsErrorLine,
  fsStrerror,
  isFsError,
  isMissingPath,
  noMount,
  listingError,
  readdirError,
  revoiceFsErrorLine,
  isDotWalkError,
  walkRefusal,
} from './errors.ts'
import { PathSpec } from '../types.ts'

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
const DEC = new TextDecoder()

describe('formatFsError', () => {
  it('prefixes a thrown command error with the command name (GNU prog: message)', () => {
    const line = decode(
      formatFsError(
        'slack-add-reaction',
        new Error('Slack API error (reactions.add): message_not_found'),
      ),
    )
    expect(line).toBe('slack-add-reaction: Slack API error (reactions.add): message_not_found\n')
  })

  it('stringifies a non-Error throw', () => {
    expect(decode(formatFsError('slack-add-reaction', 'boom'))).toBe('slack-add-reaction: boom\n')
  })

  it('does not double the prefix when the message already carries cmd:', () => {
    // Generic commands throw a fully GNU-formatted message (uniq: invalid
    // count); the prefix must not be doubled (uniq: uniq: ...).
    expect(decode(formatFsError('uniq', new Error("uniq: invalid count: '2junk'")))).toBe(
      "uniq: invalid count: '2junk'\n",
    )
  })

  it('renders a recognized filesystem error as cmd: path: strerror', () => {
    expect(decode(formatFsError('cat', enoent('/b/missing.txt')))).toBe(
      'cat: /b/missing.txt: No such file or directory\n',
    )
  })

  it('rewrites the resolved path to the as-typed spelling', () => {
    const line = decode(
      formatFsError('diff', enoent('/a/missing.txt'), [
        { virtual: '/a/missing.txt', rawPath: 'missing.txt' },
      ]),
    )
    expect(line).toBe('diff: missing.txt: No such file or directory\n')
  })
})

describe('fsErrorLine — commands that name the failed open', () => {
  const ENOENT = 'No such file or directory'

  it.each([
    ['head', `head: cannot open '/data/nope.txt' for reading: ${ENOENT}\n`],
    ['tail', `tail: cannot open '/data/nope.txt' for reading: ${ENOENT}\n`],
    ['fmt', `fmt: cannot open '/data/nope.txt' for reading: ${ENOENT}\n`],
    ['split', `split: cannot open '/data/nope.txt' for reading: ${ENOENT}\n`],
    ['csplit', `csplit: cannot open '/data/nope.txt' for reading: ${ENOENT}\n`],
    ['tac', `tac: failed to open '/data/nope.txt' for reading: ${ENOENT}\n`],
    ['truncate', `truncate: cannot open '/data/nope.txt' for writing: ${ENOENT}\n`],
    ['stat', `stat: cannot statx '/data/nope.txt': ${ENOENT}\n`],
    ['sed', `sed: can't read /data/nope.txt: ${ENOENT}\n`],
    ['uniq', `uniq: /data/nope.txt: ${ENOENT}\n`],
  ])('%s reports a missing operand as a failed open', (cmd, line) => {
    expect(fsErrorLine(cmd, '/data/nope.txt', enoent('/data/nope.txt'))).toBe(line)
  })

  // GNU's own fmt and base64 lines (`fmt: read error`, `base64: read error:
  // Is a directory`) name no operand, so those keep the plain one.
  it.each([
    ['head', "head: error reading '/data/sub': Is a directory\n"],
    ['tail', "tail: error reading '/data/sub': Is a directory\n"],
    ['uniq', "uniq: error reading '/data/sub': Is a directory\n"],
    ['tac', 'tac: /data/sub: read error: Is a directory\n'],
    ['tsort', 'tsort: /data/sub: read error: Is a directory\n'],
    ['sed', 'sed: read error on /data/sub: Is a directory\n'],
    ['truncate', "truncate: cannot open '/data/sub' for writing: Is a directory\n"],
    ['fmt', 'fmt: /data/sub: Is a directory\n'],
    ['base64', 'base64: /data/sub: Is a directory\n'],
  ])('%s reports a directory as a failed read', (cmd, line) => {
    expect(fsErrorLine(cmd, '/data/sub', eisdir('/data/sub'))).toBe(line)
  })

  it.each([
    ['head', `head: cannot open "it's.txt" for reading: ${ENOENT}\n`],
    ['stat', `stat: cannot statx "it's.txt": ${ENOENT}\n`],
    ['sed', `sed: can't read it's.txt: ${ENOENT}\n`],
  ])('%s quotes the operand as typed', (cmd, line) => {
    const spec = { virtual: "/data/it's.txt", rawPath: "it's.txt" }
    expect(fsErrorLine(cmd, spec, enoent(spec))).toBe(line)
  })

  // A line that is cat's own for the operand is said again from its
  // strerror; one about another path only has its prefix swapped.
  it.each([
    [
      'cat: /b/nope: No such file or directory',
      "sed: can't read /b/nope: No such file or directory",
    ],
    ["cat: '/b/a b': Is a directory", 'sed: read error on /b/a b: Is a directory'],
    ['cat: /b/other: No such file or directory', 'sed: /b/other: No such file or directory'],
    ['unrelated', 'unrelated'],
  ])('revoices %j in the real command voice', (line, said) => {
    const operand = line.includes('a b') ? '/b/a b' : '/b/nope'
    expect(revoiceFsErrorLine(line, 'cat', 'sed', operand)).toBe(said)
  })

  it('leaves standard input bare', () => {
    expect(fsErrorLine('tail', '-', ebadfStdin())).toBe('tail: -: Bad file descriptor\n')
  })

  it('words a head open failure at the chokepoint', () => {
    expect(decode(formatFsError('head', enoent('/a/gone.txt')))).toBe(
      "head: cannot open '/a/gone.txt' for reading: No such file or directory\n",
    )
  })

  it.each([
    ['tac', "failed to open '/data/a.txt/x' for reading"],
    ['stat', "cannot statx '/data/a.txt/x'"],
    ['truncate', "cannot open '/data/a.txt/x' for writing"],
  ])('%s names its own failed step', (cmd, step) => {
    // The errno is the backend's either way; only the step and the quoting
    // are the command's (coreutils 9.7).
    expect(fsErrorLine(cmd, '/data/a.txt/x', enoent('/data/a.txt/x'))).toBe(
      `${cmd}: ${step}: No such file or directory\n`,
    )
    expect(fsErrorLine(cmd, '/data/a.txt/x', enotdir('/data/a.txt/x'))).toBe(
      `${cmd}: ${step}: Not a directory\n`,
    )
  })

  it('names a tac directory read first and quotes it only when needed', () => {
    // tac's read failure leads with the name, which GNU quotes the way
    // quotef does: only a name that needs it, ':' included.
    expect(fsErrorLine('tac', '/data/sub', eisdir('/data/sub'))).toBe(
      'tac: /data/sub: read error: Is a directory\n',
    )
    expect(fsErrorLine('tac', '/data/a b', eisdir('/data/a b'))).toBe(
      "tac: '/data/a b': read error: Is a directory\n",
    )
    expect(fsErrorLine('tac', '/data/c:d', eisdir('/data/c:d'))).toBe(
      "tac: '/data/c:d': read error: Is a directory\n",
    )
  })

  it('says one step for a stat or truncate directory', () => {
    expect(fsErrorLine('truncate', '/data/sub', eisdir('/data/sub'))).toBe(
      "truncate: cannot open '/data/sub' for writing: Is a directory\n",
    )
    expect(fsErrorLine('stat', '/data/sub', eisdir('/data/sub'))).toBe(
      "stat: cannot statx '/data/sub': Is a directory\n",
    )
  })

  it('escapes a control character in a step line', () => {
    expect(fsErrorLine('stat', '/data/a\tb', enoent('/data/a\tb'))).toBe(
      "stat: cannot statx '/data/a'$'\\t''b': No such file or directory\n",
    )
  })

  it('leaves tac standard input bare', () => {
    expect(fsErrorLine('tac', '-', ebadfStdin())).toBe('tac: -: Bad file descriptor\n')
  })

  it('names an empty operand as typed', () => {
    // An empty rawPath is the operand as typed, not a missing one; the
    // Python formatter reads it the same way.
    const spec = { virtual: '/data', rawPath: '' }
    expect(fsErrorLine('tac', spec, enoent(spec))).toBe(
      "tac: failed to open '' for reading: No such file or directory\n",
    )
    expect(fsErrorLine('cat', spec, enoent(spec))).toBe("cat: '': No such file or directory\n")
  })

  it('words a stat failure at the chokepoint', () => {
    expect(decode(formatFsError('stat', enoent('/a/gone.txt')))).toBe(
      "stat: cannot statx '/a/gone.txt': No such file or directory\n",
    )
  })
})

describe('enotsup', () => {
  it('carries the op and the operand', () => {
    const err = enotsup('email', 'unlink', '/mail/inbox/a.txt')
    expect(err.code).toBe('ENOTSUP')
    expect(err.op).toBe('unlink')
    expect(err.virtualPath).toBe('/mail/inbox/a.txt')
    expect(err.message).toContain('no op registered: unlink')
  })

  it('is a recognized fs error with GNU strerror text', () => {
    const err = enotsup('email', 'unlink', '/mail/a.txt')
    expect(isFsError(err)).toBe(true)
    expect(fsStrerror(err)).toBe('Operation not supported')
  })

  it('formats as a GNU operand line at the chokepoint', () => {
    const line = formatFsError('mv', enotsup('email', 'unlink', '/mail/a.txt'))
    expect(DEC.decode(line)).toBe('mv: /mail/a.txt: Operation not supported\n')
  })
})

describe('efbig', () => {
  it('is a per-operand fs error that formats as GNU File too large', () => {
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
    // GNU `ls /data/nope/deeper` reports the missing component, not ENOTDIR.
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
