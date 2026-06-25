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
import { command } from '../commands/config.ts'
import { specOf } from '../commands/spec/builtins.ts'
import { IOResult } from '../io/types.ts'
import type { RegisteredOp } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { MountMode, ResourceName, type PathSpec } from '../types.ts'
import { MountEntry } from './mount/mount.ts'
import { Workspace } from './workspace.ts'

const ENC = new TextEncoder()

const echopath = command({
  name: 'echopath',
  resource: ResourceName.RAM,
  spec: specOf('cat'),
  fn: (_accessor, paths: readonly PathSpec[]) => {
    const first = paths[0]
    if (first === undefined) {
      return [
        null,
        new IOResult({ exitCode: 1, stderr: ENC.encode('echopath: missing operand\n') }),
      ]
    }
    return [ENC.encode(`echopath:${first.original}`), new IOResult()]
  },
})

const helloOp: RegisteredOp = {
  name: 'hello_op',
  resource: ResourceName.RAM,
  filetype: null,
  fn: (_accessor, path) => `hello:${path.original}`,
  write: false,
}

function mkWs(): Workspace {
  return new Workspace({ '/data/': new RAMResource() }, { mode: MountMode.WRITE })
}

describe('Workspace.cacheMount accessor', () => {
  it('returns a Mount that is the registry default mount', () => {
    const ws = mkWs()
    expect(ws.cacheMount).toBeInstanceOf(MountEntry)
    expect(ws.cacheMount).toBe(ws.registry.defaultMount)
    expect(ws.cacheMount.prefix).toBe('/_default/')
  })

  it('cacheMount.resource is the workspace cache', () => {
    const ws = mkWs()
    expect(ws.cacheMount.resource).toBe(ws.cache)
  })
})

describe('Workspace.cacheMount.registerFns', () => {
  it('accepts a RAM-typed command', () => {
    const ws = mkWs()
    ws.cacheMount.registerFns(echopath)
    const cmd = ws.cacheMount.resolveCommand('echopath')
    expect(cmd).not.toBeNull()
    expect(cmd?.name).toBe('echopath')
  })

  it('accepts a RAM-typed op', () => {
    const ws = mkWs()
    ws.cacheMount.registerFns([helloOp])
    const registered = ws.cacheMount.registeredOps()
    expect(registered.hello_op).toBeDefined()
  })

  it('rejects a command whose resource kind mismatches the cache', () => {
    const ws = mkWs()
    const diskOnly = command({
      name: 'disk_only',
      resource: ResourceName.DISK,
      spec: specOf('cat'),
      fn: () => [null, new IOResult()],
    })
    expect(() => {
      ws.cacheMount.registerFns(diskOnly)
    }).toThrow(/'disk'/)
  })

  it('multi-resource command filters to matching resource', () => {
    const ws = mkWs()
    const multi = command({
      name: 'multi',
      resource: [ResourceName.RAM, ResourceName.S3],
      spec: specOf('cat'),
      fn: () => [null, new IOResult()],
    })
    ws.cacheMount.registerFns(multi)
    const cmd = ws.cacheMount.resolveCommand('multi')
    expect(cmd).not.toBeNull()
    expect(cmd?.resource).toBe(ResourceName.RAM)
  })

  it('multi-resource command with no matching resource throws', () => {
    const ws = mkWs()
    const noneMatch = command({
      name: 'noneMatch',
      resource: [ResourceName.S3, ResourceName.DISK],
      spec: specOf('cat'),
      fn: () => [null, new IOResult()],
    })
    expect(() => {
      ws.cacheMount.registerFns(noneMatch)
    }).toThrow(/'disk'.*'s3'/)
  })

  it('multi-resource op filters to matching resource', () => {
    const ws = mkWs()
    const fn = (_acc: unknown, p: PathSpec): string => `multi:${p.original}`
    const multiOps: RegisteredOp[] = [
      { name: 'multi_op', resource: ResourceName.RAM, filetype: null, fn, write: false },
      { name: 'multi_op', resource: ResourceName.S3, filetype: null, fn, write: false },
    ]
    ws.cacheMount.registerFns(multiOps)
    expect(ws.cacheMount.registeredOps().multi_op).toBeDefined()
  })

  it('multi-resource op with no matching resource throws', () => {
    const ws = mkWs()
    const fn = (_acc: unknown, p: PathSpec): string => p.original
    const noneMatchOps: RegisteredOp[] = [
      { name: 'none_op', resource: ResourceName.S3, filetype: null, fn, write: false },
      { name: 'none_op', resource: ResourceName.DISK, filetype: null, fn, write: false },
    ]
    expect(() => {
      ws.cacheMount.registerFns(noneMatchOps)
    }).toThrow(/'disk'.*'s3'/)
  })
})

describe('setDefaultMount ops symmetry', () => {
  it('auto-registers resource.ops() on the cache mount, mirroring mount()', () => {
    const ws = mkWs()
    const cacheOps = ws.cacheMount.registeredOps()
    const resourceOpNames = new Set((ws.cacheMount.resource.ops?.() ?? []).map((o) => o.name))
    for (const name of resourceOpNames) {
      expect(cacheOps[name]).toBeDefined()
    }
  })
})
