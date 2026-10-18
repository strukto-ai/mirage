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

import { chmod, mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spec, tmpRoot } from '../../../tests/test-utils.ts'
import { basename, norm, parent, resolveInside, resolveSafe } from './utils.ts'

describe('resolveSafe', () => {
  it('joins root with virtual path', () => {
    expect(resolveSafe('/tmp/r', '/a/b.txt')).toBe(resolve('/tmp/r', 'a/b.txt'))
  })
  it('strips leading slash from virtual', () => {
    expect(resolveSafe('/tmp/r', '/x')).toBe(resolve('/tmp/r', 'x'))
  })
  it('returns root when virtual is empty/slash', () => {
    expect(resolveSafe('/tmp/r', '/')).toBe(resolve('/tmp/r'))
  })
  it('throws when virtual escapes the root via ..', () => {
    expect(() => resolveSafe('/tmp/r', '/../escaped')).toThrow(/escapes root/)
  })
  it('allows nested paths within root', () => {
    expect(resolveSafe('/tmp/r', '/a/b/c')).toBe(resolve('/tmp/r', 'a/b/c'))
  })
  it('uses platform separator', () => {
    const res = resolveSafe('/tmp/r', '/a/b')
    expect(res.endsWith(`a${sep}b`)).toBe(true)
  })
})

describe('norm', () => {
  it('always returns leading slash', () => {
    expect(norm('foo')).toBe('/foo')
  })
  it('strips trailing slashes', () => {
    expect(norm('/foo///')).toBe('/foo')
  })
  it('handles empty string', () => {
    expect(norm('')).toBe('/')
  })
  it('handles root', () => {
    expect(norm('/')).toBe('/')
  })
})

describe('parent', () => {
  it('returns the parent directory', () => {
    expect(parent('/a/b/c')).toBe('/a/b')
  })
  it('returns / for top-level paths', () => {
    expect(parent('/x')).toBe('/')
  })
  it('returns / for /', () => {
    expect(parent('/')).toBe('/')
  })
})

describe('basename', () => {
  it('returns the last segment', () => {
    expect(basename('/a/b/c')).toBe('c')
  })
  it('returns / for /', () => {
    expect(basename('/')).toBe('/')
  })
  it('handles single-segment paths', () => {
    expect(basename('/x')).toBe('x')
  })
})

describe('resolveInside', () => {
  let root: string
  let outside: string
  let cleanup: () => void
  let cleanupOutside: () => void

  beforeEach(async () => {
    ;({ root, cleanup } = tmpRoot('mirage-core-disk-inside-'))
    ;({ root: outside, cleanup: cleanupOutside } = tmpRoot('mirage-core-disk-outside-'))
    await mkdir(join(root, 'lib'))
    await writeFile(join(root, 'lib', 'a.txt'), 'a')
    await writeFile(join(outside, 'secret.txt'), 's')
    await symlink('lib', join(root, 'lib64'))
    await symlink(join(outside, 'secret.txt'), join(root, 'abs'))
    await symlink(join('..', 'nope', 'python3'), join(root, 'dangling'))
  })
  afterEach(() => {
    cleanup()
    cleanupOutside()
  })

  it('answers the host path for a path with no link in it', async () => {
    expect(await resolveInside(root, spec('/lib/a.txt'))).toBe(join(resolve(root), 'lib', 'a.txt'))
  })
  it('answers a path past an absent component, for the op to create or refuse', async () => {
    expect(await resolveInside(root, spec('/new/x.txt'))).toBe(join(resolve(root), 'new', 'x.txt'))
  })
  it('refuses a directory link on the way as ENOENT naming the operand', async () => {
    await expect(resolveInside(root, spec('/lib64/a.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
      message: '/lib64/a.txt',
    })
  })
  it('refuses a link out of the root as the leaf', async () => {
    await expect(resolveInside(root, spec('/abs'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('refuses a dangling link', async () => {
    await expect(resolveInside(root, spec('/dangling'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('names the operand, not the host, when a component is unreadable', async () => {
    await mkdir(join(root, 'locked'))
    await writeFile(join(root, 'locked', 'f.txt'), 'x')
    await chmod(join(root, 'locked'), 0)
    try {
      const err = await resolveInside(root, spec('/locked/f.txt')).then(
        () => null,
        (e: unknown) => e as Error & { code?: string },
      )
      expect(err?.code).toBe('EACCES')
      expect(err?.message).toBe('/locked/f.txt')
    } finally {
      await chmod(join(root, 'locked'), 0o755)
    }
  })
  it('accepts infrastructure root aliases but rejects links below them', async () => {
    const alias = join(outside, 'root-alias')
    await symlink(root, alias)
    expect(await resolveInside(alias, spec('/lib/a.txt'))).toBe(join(alias, 'lib/a.txt'))
    await expect(resolveInside(alias, spec('/lib64/a.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
  it('allows a filesystem root mount', async () => {
    const canonical = await realpath(root)
    expect(await resolveInside('/', spec(canonical))).toBe(canonical)
  })
  it('still refuses a .. escape', async () => {
    await expect(resolveInside(root, spec('/../escaped'))).rejects.toThrow(/escapes root/)
  })
})
