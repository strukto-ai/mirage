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

import type { Context } from '../../../src/commands/config.ts'
import { IOResult } from '../../../src/io/types.ts'
import { MountCore } from '../../../src/mount/core.ts'
import type { Runtime } from '../../../src/runtime/base.ts'
import { WorkspaceBinding } from '../../../src/runtime/binding.ts'
import { RuntimeFiles } from '../../../src/runtime/files.ts'
import type { MountResolver } from '../../../src/runtime/resolver.ts'
import type { BridgeDispatchFn, BridgeOpAttrs, DispatchFn } from '../../../src/runtime/types.ts'
import type { PathSpec } from '../../../src/types.ts'
import { Files } from '../../../src/workspace/files.ts'
import { context } from '../../workspace/fixtures/context.ts'

// The files each runtime `bindOver` bound runs over.
const runFiles = new WeakMap<Runtime, Files>()

/**
 * The dispatcher a run's files call, over a double that answers the
 * bridge's ops: each call reaches it as `workspaceBridge` would have sent
 * it, so a test keeps its double while its run gets real files, and the
 * open-file core over them. Python's tests stand a dispatcher double up
 * directly.
 */
export function dispatchOver(bridge: BridgeDispatchFn): DispatchFn {
  return async (name, path, args = [], kwargs = {}) => {
    const p = path.virtual
    const flag = (key: string): boolean => kwargs[key] === true
    const attrs: BridgeOpAttrs = {}
    let out: unknown
    switch (name) {
      case 'read':
        if (kwargs.filetype === null) attrs.raw = true
        if (typeof kwargs.offset === 'number') attrs.offset = kwargs.offset
        if (typeof kwargs.size === 'number') attrs.size = kwargs.size
        if (flag('direct')) attrs.direct = true
        if (kwargs.retained !== undefined) attrs.retained = kwargs.retained as Uint8Array
        out = await bridge('read', p, undefined, undefined, attrs)
        break
      case 'write':
        out = flag('admit_only')
          ? await bridge('write', p, undefined, undefined, { admitOnly: true })
          : await bridge('write', p, args[0] as Uint8Array)
        break
      case 'append':
        out = await bridge('append', p, args[0] as Uint8Array)
        break
      case 'pwrite':
        out = await bridge('pwrite', p, args[0] as Uint8Array, undefined, {
          offset: args[1] as number,
        })
        break
      case 'stat':
        if (flag('nofollow')) attrs.nofollow = true
        if (flag('admit_only')) attrs.admitOnly = true
        if (kwargs.retained !== undefined) attrs.retained = kwargs.retained as Uint8Array
        out = await bridge('stat', p, undefined, undefined, attrs)
        break
      case 'truncate':
        out = await bridge('truncate', p, undefined, undefined, { length: args[0] as number })
        break
      case 'mkdir':
        out = await bridge(
          'mkdir',
          p,
          undefined,
          undefined,
          flag('parents') ? { parents: true } : {},
        )
        break
      case 'rename':
        out = await bridge('rename', p, undefined, (args[0] as PathSpec).virtual)
        break
      case 'symlink':
        out = await bridge('symlink', p, undefined, kwargs.target as string)
        break
      case 'setattr':
        out = await bridge('setattr', p, undefined, undefined, kwargs as BridgeOpAttrs)
        break
      case 'getxattr':
      case 'listxattr':
      case 'removexattr':
        out = await bridge(name, p, undefined, kwargs.name as string | undefined, {
          nofollow: flag('nofollow'),
        })
        break
      case 'setxattr':
        out = await bridge('setxattr', p, kwargs.value as Uint8Array, kwargs.name as string, {
          create: flag('create'),
          replace: flag('replace'),
          nofollow: flag('nofollow'),
        })
        break
      default:
        out = await bridge(name as Parameters<BridgeDispatchFn>[0], p)
    }
    return [out, new IOResult()]
  }
}

/** Bind a runtime over a bridge double, its runs' files real (`dispatchOver`). */
export function bindOver(
  runtime: Runtime,
  bridge: BridgeDispatchFn,
  resolver: MountResolver,
): void {
  const dispatch = dispatchOver(bridge)
  runtime.bind(new WorkspaceBinding(dispatch, resolver))
  runFiles.set(runtime, new Files(dispatch, null, null, { ledger: false }))
}

/**
 * A run's context for a runtime `bindOver` bound, with the files its
 * capture would hand the run (`captureBinding`), for a test that calls
 * `interpret` directly.
 */
export function runContext(runtime: Runtime, fields: Partial<Context> = {}): Context {
  const vfs = runFiles.get(runtime)
  return context(vfs === undefined ? fields : { ...fields, vfs })
}

/** A run's file adapter over a bridge double, with the open-file core a run gets. */
export function filesOver(bridge: BridgeDispatchFn, resolver: MountResolver): RuntimeFiles {
  return new RuntimeFiles(
    bridge,
    resolver,
    null,
    new MountCore(new Files(dispatchOver(bridge), null, null, { ledger: false })),
  )
}
