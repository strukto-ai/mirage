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
import { FS_CONDITIONS } from '../errors/types.ts'
import {
  CLASSIFIED_VERBS,
  PASSTHROUGH_VERBS,
  REFUSED_VERBS,
  ROUTED_VERBS,
  refusalOf,
} from './verbs.ts'

// Mirrors python/tests/runtime/test_verbs.py. Python derives the name
// set from the live `os` module and pins the linux sweep; core has no
// such module to ask, so the three tables are pinned literally here.
// The two spellings are the cross-language pin: a verb reclassified in
// one language and not the other fails on this side.
const ROUTED = [
  'access',
  'chmod',
  'chown',
  'getxattr',
  'lchmod',
  'lchown',
  'listdir',
  'listxattr',
  'lstat',
  'makedirs',
  'mkdir',
  'readlink',
  'remove',
  'removedirs',
  'removexattr',
  'rename',
  'renames',
  'replace',
  'rmdir',
  'scandir',
  'setxattr',
  'stat',
  'symlink',
  'truncate',
  'unlink',
  'utime',
  'walk',
]

const REFUSED = [
  'chdir',
  'chflags',
  'chroot',
  'fwalk',
  'lchflags',
  'link',
  'mkfifo',
  'mknod',
  'open',
  'statvfs',
]

const PASSTHROUGH = [
  'confstr',
  'copy_file_range',
  'execl',
  'execle',
  'execlp',
  'execlpe',
  'execv',
  'execve',
  'execvp',
  'execvpe',
  'fpathconf',
  'fsdecode',
  'fsencode',
  'fspath',
  'memfd_create',
  'pathconf',
  'posix_spawn',
  'posix_spawnp',
  'putenv',
  'spawnl',
  'spawnle',
  'spawnlp',
  'spawnlpe',
  'spawnv',
  'spawnve',
  'spawnvp',
  'spawnvpe',
  'splice',
  'sysconf',
  'unsetenv',
]

// The op names the workspace dispatcher answers. A routed verb naming
// anything else would refuse at runtime with a message about an unknown
// op instead of routing, which is the one failure the table exists to
// make impossible.
const DISPATCH_OPS = new Set([
  'getxattr',
  'listxattr',
  'readdir',
  'readlink',
  'removexattr',
  'rename',
  'rmdir',
  'mkdir',
  'setattr',
  'setxattr',
  'stat',
  'symlink',
  'truncate',
  'unlink',
])

describe('verb tables', () => {
  it('classify exactly the pinned names', () => {
    expect(Object.keys(ROUTED_VERBS).sort()).toEqual(ROUTED)
    expect(Object.keys(REFUSED_VERBS).sort()).toEqual(REFUSED)
    expect([...PASSTHROUGH_VERBS].sort()).toEqual(PASSTHROUGH)
    expect(CLASSIFIED_VERBS.size).toBe(ROUTED.length + REFUSED.length + PASSTHROUGH.length)
  })

  it('are disjoint', () => {
    const seen = new Set<string>()
    for (const name of [...ROUTED, ...REFUSED, ...PASSTHROUGH]) {
      expect(seen.has(name)).toBe(false)
      seen.add(name)
    }
  })

  it('route only ops the dispatcher serves', () => {
    for (const [verb, ops] of Object.entries(ROUTED_VERBS)) {
      expect(ops.length).toBeGreaterThan(0)
      for (const op of ops) expect(DISPATCH_OPS.has(op), `${verb} -> ${op}`).toBe(true)
    }
  })

  it('refuse with conditions the errno tables know', () => {
    for (const condition of Object.values(REFUSED_VERBS)) {
      expect(FS_CONDITIONS).toContain(condition)
    }
  })
})

describe('refusalOf', () => {
  it('serves a routed verb', () => {
    expect(refusalOf('symlink')).toBeNull()
  })

  it('serves a passthrough verb', () => {
    expect(refusalOf('execv')).toBeNull()
  })

  it('carries the refused verb condition', () => {
    expect(refusalOf('link')).toBe('EPERM')
    expect(refusalOf('statvfs')).toBe('ENOTSUP')
  })

  it('defaults an unknown verb to ENOTSUP', () => {
    expect(refusalOf('teleport')).toBe('ENOTSUP')
  })

  it('refuses a name inherited from the object prototype', () => {
    // A table read with `in` reports every prototype name as
    // classified, so these two would be served rather than refused.
    expect(refusalOf('toString')).toBe('ENOTSUP')
    expect(refusalOf('constructor')).toBe('ENOTSUP')
  })
})
