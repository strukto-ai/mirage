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
import { CycleError, expandTilde, resolveSymlinks } from './path.ts'

describe('expandTilde', () => {
  it('~ alone → home', () => {
    expect(expandTilde('~', '/home/u')).toBe('/home/u')
  })

  it('~/sub → home/sub', () => {
    expect(expandTilde('~/file.txt', '/home/u')).toBe('/home/u/file.txt')
  })

  it('~/sub with root home', () => {
    expect(expandTilde('~/file.txt', '/')).toBe('/file.txt')
  })

  it('~user left unchanged', () => {
    expect(expandTilde('~other/x', '/home/u')).toBe('~other/x')
  })

  it('non-leading ~ left unchanged', () => {
    expect(expandTilde('a~b', '/home/u')).toBe('a~b')
  })

  it('plain word left unchanged', () => {
    expect(expandTilde('file.txt', '/home/u')).toBe('file.txt')
  })
})

describe('resolveSymlinks', () => {
  it('no links → unchanged', () => {
    expect(resolveSymlinks('/foo/bar/baz', {})).toBe('/foo/bar/baz')
  })

  it('single hop', () => {
    expect(resolveSymlinks('/foo/bar/baz', { '/foo/bar': '/abc' })).toBe('/abc/baz')
  })

  it('exact match', () => {
    expect(resolveSymlinks('/foo/bar', { '/foo/bar': '/abc' })).toBe('/abc')
  })

  it('multi-hop until stable', () => {
    expect(resolveSymlinks('/foo/bar/baz', { '/foo/bar': '/abc', '/abc': '/xyz' })).toBe('/xyz/baz')
  })

  it('longest prefix wins', () => {
    expect(resolveSymlinks('/foo/bar/baz', { '/foo': '/q', '/foo/bar': '/abc' })).toBe('/abc/baz')
  })

  it('boundary not substring', () => {
    expect(resolveSymlinks('/foo/barbaz', { '/foo/bar': '/abc' })).toBe('/foo/barbaz')
  })

  it('cross-mount target', () => {
    expect(resolveSymlinks('/ram/link/x', { '/ram/link': '/s3/data' })).toBe('/s3/data/x')
  })

  it('relative target against link dir', () => {
    expect(resolveSymlinks('/ram/sub/dlink', { '/ram/sub/dlink': 'deep.txt' })).toBe(
      '/ram/sub/deep.txt',
    )
  })

  it('relative target with suffix', () => {
    expect(resolveSymlinks('/ram/sub/dlink/x', { '/ram/sub/dlink': 'peer' })).toBe(
      '/ram/sub/peer/x',
    )
  })

  it('cycle raises', () => {
    expect(() => resolveSymlinks('/a', { '/a': '/b', '/b': '/a' })).toThrow(CycleError)
  })

  it('self-cycle raises', () => {
    expect(() => resolveSymlinks('/a/x', { '/a': '/a/y' })).toThrow(CycleError)
  })
})
