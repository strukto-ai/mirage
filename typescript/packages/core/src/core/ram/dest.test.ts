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
import { RAMAccessor } from '../../accessor/ram.ts'
import { PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import { RAMStore } from '../../vfs/ram/store.ts'
import { copy } from './copy.ts'
import { lookupError } from './dest.ts'
import { read } from './read.ts'
import { rename } from './rename.ts'
import { rmdir } from './rmdir.ts'
import { setAttrs } from './set_attrs.ts'
import { stat } from './stat.ts'
import { readStream } from './stream.ts'
import { unlink } from './unlink.ts'

function mkPath(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: stripSlash(virtual), resolved: true })
}

function mkAccessor(): RAMAccessor {
  const store = new RAMStore()
  const enc = new TextEncoder()
  store.files.set('/a.txt', enc.encode('a'))
  store.dirs.add('/d')
  store.files.set('/orphan/a.txt', enc.encode('o'))
  return new RAMAccessor(store)
}

async function drain(accessor: RAMAccessor, path: PathSpec): Promise<void> {
  for await (const chunk of readStream(accessor, path)) void chunk
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn()
  } catch (err) {
    return (err as { code?: string }).code
  }
  return undefined
}

// GNU resolves a path one component at a time and stops at the first that
// is not a directory; measured against coreutils 9.7 (`cat a.txt/x` is "Not
// a directory", `cat nope/x` is "No such file or directory"). Mirrors
// test_dest.py.
describe('lookupError', () => {
  it.each([
    ['/a.txt/x', 'ENOTDIR'],
    ['/a.txt/x/y', 'ENOTDIR'],
    ['/d/a.txt/x', 'ENOENT'],
    ['/d/x', 'ENOENT'],
    ['/nope/x', 'ENOENT'],
    ['/nope', 'ENOENT'],
    ['/orphan/b.txt', 'ENOENT'],
  ])('stops at the first non-directory: %s is %s', (key, code) => {
    const error = lookupError(mkAccessor(), mkPath(key), key)
    expect(error.code).toBe(code)
    expect(error.virtualPath).toBe(key)
  })
})

describe('every lookup names a plain-file parent', () => {
  const ops: Record<string, (a: RAMAccessor, p: PathSpec) => Promise<unknown>> = {
    read: (a, p) => read(a, p),
    stream: drain,
    stat: (a, p) => stat(a, p),
    setAttrs: (a, p) => Promise.resolve().then(() => setAttrs(a, p, { mode: 0o644 })),
    unlink: (a, p) => unlink(a, p),
    rmdir: (a, p) => rmdir(a, p),
    copy: (a, p) => copy(a, p, mkPath('/copy.txt')),
    rename: (a, p) => rename(a, p, mkPath('/moved.txt')),
  }
  it.each(Object.keys(ops))('%s', async (name) => {
    const op = ops[name]
    if (op === undefined) throw new Error(name)
    expect(await codeOf(() => op(mkAccessor(), mkPath('/a.txt/x')))).toBe('ENOTDIR')
    expect(await codeOf(() => op(mkAccessor(), mkPath('/nope/x')))).toBe('ENOENT')
  })
})
