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
import { parseMode } from '../../handles/mode.ts'
import { ScratchTree } from './tree.ts'

// The messages are pydantic-monty's own (os_access.py), byte for byte:
// they are what a python-host guest reads, so the two hosts cannot be
// told apart by their scratch errors.

describe('ScratchTree reads and writes', () => {
  it('round-trips text and bytes, and reports python len for text', () => {
    const tree = new ScratchTree()
    tree.write('/a.txt', 'héllo')
    expect(tree.readText('/a.txt')).toBe('héllo')
    tree.write('/b.bin', new Uint8Array([0, 1, 2]))
    expect(tree.readBytes('/b.bin')).toEqual(new Uint8Array([0, 1, 2]))
    expect(new TextDecoder().decode(tree.readBytes('/a.txt'))).toBe('héllo')
  })

  it('spells a missing file the way python does', () => {
    const tree = new ScratchTree()
    expect(() => tree.readText('/nope')).toThrow("[Errno 2] No such file or directory: '/nope'")
    try {
      tree.readText('/nope')
    } catch (err) {
      expect((err as Error).name).toBe('FileNotFoundError')
    }
  })

  it('refuses to write over a directory or under a missing parent', () => {
    const tree = new ScratchTree()
    tree.mkdir('/d', false, false)
    expect(() => {
      tree.write('/d', 'x')
    }).toThrow("[Errno 21] Is a directory: '/d'")
    expect(() => {
      tree.write('/missing/x', 'v')
    }).toThrow("[Errno 2] No such file or directory: '/missing/x'")
  })

  it('append tracks the storage type of the most recent write', () => {
    const tree = new ScratchTree()
    tree.write('/log', 'ab')
    tree.append('/log', 'c')
    expect(tree.readText('/log')).toBe('abc')
    tree.append('/log', new Uint8Array([100]))
    expect(tree.readBytes('/log')).toEqual(new TextEncoder().encode('abcd'))
    tree.append('/fresh', 'seed')
    expect(tree.readText('/fresh')).toBe('seed')
  })
})

describe('ScratchTree stat', () => {
  it('reports a file at its byte length, with the mode monty gives a tree file', () => {
    const tree = new ScratchTree()
    const before = Date.now()
    tree.write('/a.txt', 'héllo')
    const st = tree.stat('/a.txt')
    expect(st).toMatchObject({ size: 6, isDir: false, mode: 0o100644 })
    expect(st.mtimeMs).toBeGreaterThanOrEqual(before)
  })

  it('reports a directory with monty tree defaults', () => {
    const tree = new ScratchTree()
    tree.mkdir('/d', false, false)
    expect(tree.stat('/d')).toMatchObject({ isDir: true, mode: 0o40755 })
  })

  it('spells a missing path the way every other read does', () => {
    expect(() => new ScratchTree().stat('/nope')).toThrow(
      "[Errno 2] No such file or directory: '/nope'",
    )
  })

  it('carries the stamp through a rename, since it rides on the node', () => {
    const tree = new ScratchTree()
    tree.write('/a.txt', 'x')
    const stamp = tree.stat('/a.txt').mtimeMs
    tree.rename('/a.txt', '/b.txt')
    expect(tree.stat('/b.txt').mtimeMs).toBe(stamp)
  })
})

describe('ScratchTree open establishing', () => {
  it("'r' verifies, 'w' truncates or creates, 'a' creates what is missing", () => {
    const tree = new ScratchTree()
    expect(() => {
      tree.open('/x', parseMode('r'))
    }).toThrow("[Errno 2] No such file or directory: '/x'")
    tree.open('/x', parseMode('w'))
    expect(tree.readText('/x')).toBe('')
    tree.write('/x', 'keep')
    tree.open('/x', parseMode('a'))
    expect(tree.readText('/x')).toBe('keep')
    tree.open('/x', parseMode('w'))
    expect(tree.readText('/x')).toBe('')
  })

  it("'x' refuses what exists and creates what does not", () => {
    const tree = new ScratchTree()
    tree.open('/new', parseMode('x'))
    expect(tree.readText('/new')).toBe('')
    expect(() => {
      tree.open('/new', parseMode('x'))
    }).toThrow("[Errno 17] File exists: '/new'")
  })

  it("a binary 'w' seeds bytes, so a later read_bytes needs no decode", () => {
    const tree = new ScratchTree()
    tree.open('/b', parseMode('wb'))
    expect(tree.readBytes('/b')).toEqual(new Uint8Array())
  })
})

describe('ScratchTree mkdir', () => {
  it('follows pathlib: exist_ok forgives a directory, never a file', () => {
    const tree = new ScratchTree()
    tree.mkdir('/d', false, false)
    expect(() => {
      tree.mkdir('/d', false, false)
    }).toThrow("[Errno 17] File exists: '/d'")
    tree.mkdir('/d', false, true)
    tree.write('/f', 'x')
    expect(() => {
      tree.mkdir('/f', false, true)
    }).toThrow("[Errno 17] File exists: '/f'")
  })

  it('parents creates the chain; without it a missing parent misses', () => {
    const tree = new ScratchTree()
    expect(() => {
      tree.mkdir('/a/b/c', false, false)
    }).toThrow("[Errno 2] No such file or directory: '/a/b/c'")
    tree.mkdir('/a/b/c', true, false)
    expect(tree.isDir('/a/b/c')).toBe(true)
  })

  it('a file in the parent chain answers NotADirectoryError', () => {
    const tree = new ScratchTree()
    tree.write('/f', 'x')
    expect(() => {
      tree.mkdir('/f/sub', false, false)
    }).toThrow("[Errno 20] Not a directory: '/f/sub'")
    expect(() => {
      tree.mkdir('/f/a/b', true, false)
    }).toThrow("[Errno 20] Not a directory: '/f/a/b'")
  })
})

describe('ScratchTree removal and listing', () => {
  it('unlink removes files only, rmdir removes empty directories only', () => {
    const tree = new ScratchTree()
    tree.write('/f', 'x')
    tree.mkdir('/d', false, false)
    expect(() => {
      tree.unlink('/d')
    }).toThrow("[Errno 21] Is a directory: '/d'")
    tree.unlink('/f')
    expect(tree.exists('/f')).toBe(false)
    tree.write('/d/inner', 'x')
    expect(() => {
      tree.rmdir('/d')
    }).toThrow("[Errno 39] Directory not empty: '/d'")
    tree.unlink('/d/inner')
    tree.rmdir('/d')
    expect(tree.exists('/d')).toBe(false)
  })

  it('iterdir lists full paths in insertion order, and / holds the tree', () => {
    const tree = new ScratchTree()
    tree.write('/b.txt', '1')
    tree.mkdir('/a', false, false)
    expect(tree.iterdir('/')).toEqual(['/b.txt', '/a'])
    expect(tree.exists('/')).toBe(true)
    expect(() => tree.iterdir('/b.txt')).toThrow("[Errno 20] Not a directory: '/b.txt'")
  })
})

describe('ScratchTree rename', () => {
  it('moves a file, overwrites a file target, and survives a following unlink', () => {
    // pydantic-monty's own tree loses the file's key on rename (the
    // KeyError python works around with _restamp); this tree re-keys,
    // which is the behavior python guests see after the workaround.
    const tree = new ScratchTree()
    tree.write('/a', 'one')
    tree.write('/b', 'two')
    tree.rename('/a', '/b')
    expect(tree.readText('/b')).toBe('one')
    expect(tree.exists('/a')).toBe(false)
    tree.unlink('/b')
    expect(tree.exists('/b')).toBe(false)
  })

  it('spells its failures with both paths, as python does', () => {
    const tree = new ScratchTree()
    expect(() => {
      tree.rename('/gone', '/x')
    }).toThrow("[Errno 2] No such file or directory: '/gone' -> '/x'")
    tree.write('/f', 'x')
    tree.mkdir('/d', false, false)
    expect(() => {
      tree.rename('/f', '/d')
    }).toThrow("[Errno 21] Is a directory: '/f' -> '/d'")
    tree.mkdir('/e', false, false)
    tree.write('/e/inner', 'x')
    expect(() => {
      tree.rename('/d', '/e')
    }).toThrow("[Errno 66] Directory not empty: '/d' -> '/e'")
    expect(() => {
      tree.rename('/d', '/f')
    }).toThrow("[Errno 20] Not a directory: '/d' -> '/f'")
  })

  it('moves a directory with its contents', () => {
    const tree = new ScratchTree()
    tree.mkdir('/src', false, false)
    tree.write('/src/f', 'x')
    tree.rename('/src', '/dst')
    expect(tree.readText('/dst/f')).toBe('x')
    expect(tree.exists('/src')).toBe(false)
  })

  it('refuses to move a directory into its own subtree, as rename(2) does', () => {
    // Detach-then-insert would orphan the data inside the detached map;
    // EINVAL is what CPython raises for exactly this move.
    const tree = new ScratchTree()
    tree.mkdir('/src', false, false)
    tree.mkdir('/src/sub', false, false)
    tree.write('/src/f', 'x')
    expect(() => {
      tree.rename('/src', '/src/sub/moved')
    }).toThrow("[Errno 22] Invalid argument: '/src' -> '/src/sub/moved'")
    // Nothing moved and nothing was orphaned.
    expect(tree.readText('/src/f')).toBe('x')
    expect(tree.isDir('/src/sub')).toBe(true)
    // A sibling whose name merely extends the prefix is not a descendant.
    tree.mkdir('/srcx', false, false)
    tree.rename('/srcx', '/src/sub/ok')
    expect(tree.isDir('/src/sub/ok')).toBe(true)
  })
})
