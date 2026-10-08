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

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { MountMode } from '../types.ts'
import { Workspace } from '../workspace/workspace/workspace.ts'
import type { NamespaceLinks } from './types.ts'

// The seam's members in declaration order. The Python twin
// (tests/doors/test_types.py) pins this same list snake_cased and in
// this same order, so a member added, dropped or moved in one language
// fails the other language's test instead of drifting quietly.
const MEMBERS = ['follow', 'isLink', 'readlink', 'linkStatAt', 'symlinkTargets'] as const

// An interface has no runtime shape, so order is read back off the
// source the way Python reads it off the class dict.
function declared(): string[] {
  const src = readFileSync(new URL('./types.ts', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('export interface NamespaceLinks {'))
  return [...body.slice(0, body.indexOf('\n}')).matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1] ?? '')
}

describe('NamespaceLinks', () => {
  it('declares the members the Python twin declares, in that order', () => {
    expect(declared()).toEqual([...MEMBERS])
  })

  it('carries no mutator', () => {
    // Creating and removing a link belongs to the op door, which is the
    // only layer that sees both planes: it decides symlink(2)'s refusal
    // to overwrite an occupied name, and it is where session grants,
    // admission policies and the ledger fire. A mutator here is a write
    // at a layer no session view covers, which is how a session-scoped
    // kernel mount came to delete a link on a mount its profile hides.
    // Checked at compile time as well: a member returning a Promise
    // fails to satisfy `never` below.
    type Async = {
      [K in keyof NamespaceLinks]: ReturnType<NamespaceLinks[K]> extends Promise<unknown>
        ? K
        : never
    }[keyof NamespaceLinks]
    const noMutator: Async extends never ? true : false = true
    expect(noMutator).toBe(true)
    expect(declared()).not.toContain('symlink')
    expect(declared()).not.toContain('unlink')
  })

  it('is still satisfied by the workspace Namespace', () => {
    // Narrowing the seam must not cost the structural match, and the
    // concrete Namespace keeps the mutators the door calls on it.
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
    const links: NamespaceLinks = ws.namespace
    expect(links.symlinkTargets()).toBeInstanceOf(Map)
    expect(typeof ws.namespace.symlink).toBe('function')
    expect(typeof ws.namespace.unlink).toBe('function')
  })
})
