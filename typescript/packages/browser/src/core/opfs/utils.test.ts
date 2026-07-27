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
import { makeMockRoot } from '../../test-utils.ts'
import {
  basename,
  dirname,
  isNotFound,
  isTypeMismatch,
  norm,
  parent,
  resolveDirHandle,
  resolveFileHandle,
  resolveParentDirHandle,
  splitSegments,
  toWritableChunk,
} from './utils.ts'

describe('opfs/utils — string helpers', () => {
  it('norm strips slashes and adds leading slash', () => {
    expect(norm('foo')).toBe('/foo')
    expect(norm('/foo///')).toBe('/foo')
    expect(norm('')).toBe('/')
  })
  it('parent returns parent directory or root', () => {
    expect(parent('/a/b/c')).toBe('/a/b')
    expect(parent('/x')).toBe('/')
    expect(parent('/')).toBe('/')
  })
  it('basename returns last segment', () => {
    expect(basename('/a/b/c')).toBe('c')
    expect(basename('/x')).toBe('x')
    expect(basename('/')).toBe('/')
  })
  it('dirname returns parent or empty', () => {
    expect(dirname('/a/b')).toBe('/a')
    expect(dirname('/x')).toBe('/')
    expect(dirname('plain')).toBe('')
  })
})

describe('opfs/utils — splitSegments', () => {
  it('splits on / and skips empty + .', () => {
    expect(splitSegments('/a/b/./c')).toEqual(['a', 'b', 'c'])
  })
  it('handles .. by popping', () => {
    expect(splitSegments('/a/b/../c')).toEqual(['a', 'c'])
  })
  it('throws when .. escapes the root', () => {
    expect(() => splitSegments('/../escape')).toThrow(/escapes root/)
  })
})

describe('opfs/utils — handle resolvers (against mock OPFS)', () => {
  it('resolveDirHandle navigates nested dirs (create:true)', async () => {
    const root = makeMockRoot()
    const dir = await resolveDirHandle(root, '/a/b', { create: true })
    expect(dir.kind).toBe('directory')
  })

  it('resolveDirHandle throws NotFound when missing and create:false', async () => {
    const root = makeMockRoot()
    await expect(resolveDirHandle(root, '/missing')).rejects.toBeInstanceOf(DOMException)
  })

  it('resolveFileHandle creates and finds files', async () => {
    const root = makeMockRoot()
    await resolveDirHandle(root, '/a/b', { create: true })
    const file = await resolveFileHandle(root, '/a/b/c.txt', { create: true })
    expect(file.kind).toBe('file')
    expect(file.name).toBe('c.txt')
  })

  it('resolveFileHandle create applies to the file, not its parents', async () => {
    // Creating the chain on demand would be a silent `mkdir -p` where GNU
    // reports ENOENT.
    const root = makeMockRoot()
    await expect(resolveFileHandle(root, '/a/b/c.txt', { create: true })).rejects.toBeInstanceOf(
      DOMException,
    )
  })

  it('resolveParentDirHandle splits parent + name', async () => {
    const root = makeMockRoot()
    const [dir, name] = await resolveParentDirHandle(root, '/a/b', { create: true })
    expect(dir.kind).toBe('directory')
    expect(name).toBe('b')
  })
})

describe('opfs/utils — error checks', () => {
  it('isNotFound matches DOMException with NotFoundError', () => {
    expect(isNotFound(new DOMException('x', 'NotFoundError'))).toBe(true)
    expect(isNotFound(new DOMException('x', 'OtherError'))).toBe(false)
    expect(isNotFound(new Error('plain'))).toBe(false)
  })
  it('isTypeMismatch matches DOMException with TypeMismatchError', () => {
    expect(isTypeMismatch(new DOMException('x', 'TypeMismatchError'))).toBe(true)
    expect(isTypeMismatch(new DOMException('x', 'NotFoundError'))).toBe(false)
  })
})

describe('opfs/utils — toWritableChunk', () => {
  it('wraps Uint8Array bytes in a Blob', () => {
    const blob = toWritableChunk(new Uint8Array([1, 2, 3]))
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.size).toBe(3)
  })
})
