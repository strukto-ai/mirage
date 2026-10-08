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

import type { ProcessView } from '../process/view.ts'
import { captureSessionContext } from '../context/session_context.ts'
import { captureOpPolicies } from '../policy/policies.ts'
import { captureRecordingContext } from '../observe/context.ts'
import type { NamespaceView, OpKwargs, SessionView } from '../view/types.ts'
import { PathSpec } from '../types.ts'
import { ContextScope } from '../utils/context_scope.ts'
import type { MountResolver } from './resolver.ts'
import type { BridgeDispatchFn } from './types.ts'

/** Local workspace doors captured for one execution, never guest globals. */
export interface RuntimeContext {
  readonly binding: WorkspaceBinding
  readonly dispatch: BridgeDispatchFn
  readonly resolver: MountResolver
  readonly ns: NamespaceView
  readonly sessionView: SessionView | null
  readonly cwd: PathSpec
  readonly env: Readonly<Record<string, string>>
  readonly scope: ContextScope
  readonly processes: ProcessView | null
}

/** Live workspace connection; capture creates views scoped to one execution. */
export class WorkspaceBinding {
  constructor(
    readonly dispatch: BridgeDispatchFn,
    readonly resolver: MountResolver,
    private readonly context?: (binding: WorkspaceBinding) => RuntimeContext,
  ) {}

  capture(): RuntimeContext {
    return this.context === undefined ? captureBinding(this) : this.context(this)
  }
}

/** Pin callback attribution without copying authoritative workspace state. */
export function captureBinding(
  binding: WorkspaceBinding,
  views: {
    ns?: NamespaceView
    sessionView?: SessionView
    processes?: ProcessView
    cwd?: PathSpec
    env?: Readonly<Record<string, string>>
  } = {},
  scope = new ContextScope([
    ...captureSessionContext(),
    ...captureOpPolicies(),
    ...captureRecordingContext(),
  ]),
): RuntimeContext {
  const source = views.ns ?? {}
  const links = source.links
  const mounts = source.mounts
  const ns: NamespaceView = {
    ...source,
    ...(links === undefined
      ? {}
      : {
          links: {
            statAt: scope.wrap(links.statAt.bind(links)),
            children: scope.wrap(links.children.bind(links)),
            subtree: scope.wrap(links.subtree.bind(links)),
            resolve: scope.wrap(links.resolve.bind(links)),
            exists: scope.wrap(links.exists.bind(links)),
            targetStat: scope.wrap(links.targetStat.bind(links)),
          },
        }),
    ...(mounts === undefined
      ? {}
      : {
          mounts: {
            descendants: scope.wrap(mounts.descendants.bind(mounts)),
            visibleDescendants: scope.wrap(mounts.visibleDescendants.bind(mounts)),
            isRoot: scope.wrap(mounts.isRoot.bind(mounts)),
            rootOf: scope.wrap(mounts.rootOf.bind(mounts)),
            ...(mounts.maxDuEntries === undefined
              ? {}
              : { maxDuEntries: scope.wrap(mounts.maxDuEntries.bind(mounts)) }),
          },
        }),
    ...(source.statOverlay === undefined ? {} : { statOverlay: scope.wrap(source.statOverlay) }),
    ...(source.childMounts === undefined ? {} : { childMounts: scope.wrap(source.childMounts) }),
  }
  const session = views.sessionView
  const sessionView =
    session === undefined
      ? null
      : {
          get: scope.wrap(session.get.bind(session)),
          snapshot: scope.wrap(session.snapshot.bind(session)),
          set: scope.wrap(session.set.bind(session)),
          unset: scope.wrap(session.unset.bind(session)),
          mark: scope.wrap(session.mark.bind(session)),
          isReadonly: scope.wrap(session.isReadonly.bind(session)),
          profile: scope.wrap(session.profile.bind(session)),
        }
  return Object.freeze({
    binding,
    dispatch: scope.wrap(binding.dispatch),
    resolver: {
      prefixes: scope.wrap(() => binding.resolver.prefixes()),
      ownerOf: scope.wrap((path: string) => binding.resolver.ownerOf(path)),
      linkChildren: scope.wrap((path: string) => binding.resolver.linkChildren(path)),
    },
    ns,
    sessionView,
    processes: views.processes ?? null,
    cwd: views.cwd ?? PathSpec.fromStrPath('/'),
    env: Object.freeze({ ...views.env }),
    scope,
  })
}

/**
 * The bridge a runtime's file I/O rides, over a dispatch shaped like
 * `Workspace.dispatch` (name, string path, positional args, kwargs): the
 * workspace's own for a guest, `ws.vfs.dispatch` for node's patched
 * `fs`. A read is the rendered one unless its `raw` attr asks for the
 * stored bytes, and its `offset`/`size` attrs ask for a byte range,
 * matching Python's `RuntimeVFS.read`.
 */
export function workspaceBridge(
  dispatch: (
    name: string,
    path: string,
    args?: readonly unknown[],
    kwargs?: OpKwargs,
  ) => Promise<unknown>,
): BridgeDispatchFn {
  return async (op, path, bytes, dst, attrs) => {
    switch (op) {
      case 'read': {
        const kwargs: OpKwargs = attrs?.raw === true ? { filetype: null } : {}
        if (attrs?.offset !== undefined || attrs?.size !== undefined) {
          kwargs.offset = attrs.offset ?? 0
          kwargs.size = attrs.size ?? null
        }
        return (await dispatch('read', path, [], kwargs)) as Uint8Array
      }
      case 'write': {
        if (bytes === undefined) throw new Error('write op requires bytes')
        const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayLike<number>)
        await dispatch('write', path, [buf])
        return undefined
      }
      case 'append': {
        if (bytes === undefined) throw new Error('append op requires bytes')
        const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayLike<number>)
        await dispatch('append', path, [buf])
        return undefined
      }
      case 'pwrite': {
        if (bytes === undefined) throw new Error('pwrite op requires bytes')
        await dispatch('pwrite', path, [bytes, attrs?.offset ?? 0])
        return undefined
      }
      case 'stat':
        // The mount's own row, nothing projected: the runtime door
        // builds the one VFSStat both languages read, so the two
        // tiers cannot drift into two translations of one fact.
        // `nofollow` is the only attrs field a stat carries, and it
        // is the caller's lstat; the dispatcher consumes it.
        return await dispatch(
          'stat',
          path,
          [],
          attrs?.nofollow === true ? { nofollow: true } : undefined,
        )
      case 'create':
        await dispatch('create', path)
        return undefined
      case 'truncate':
        await dispatch('truncate', path, [attrs?.length ?? 0])
        return undefined
      case 'unlink':
        await dispatch('unlink', path)
        return undefined
      case 'mkdir':
        // `parents` is pathlib's mkdir(parents=True), riding to the
        // backend op as a kwarg the way python's dispatch carries it.
        await dispatch('mkdir', path, [], attrs?.parents === true ? { parents: true } : {})
        return undefined
      case 'rmdir':
        await dispatch('rmdir', path)
        return undefined
      case 'rename': {
        if (dst === undefined) throw new Error('rename op requires dst')
        await dispatch('rename', path, [PathSpec.fromStrPath(dst)])
        return undefined
      }
      case 'symlink': {
        // The target is not a PathSpec: a link stores what was typed,
        // relative or dangling, and resolving it here would record a
        // different link than the guest asked for.
        if (dst === undefined) throw new Error('symlink op requires dst')
        await dispatch('symlink', path, [], { target: dst })
        return undefined
      }
      case 'readlink':
        return (await dispatch('readlink', path)) as string
      case 'setattr': {
        if (attrs === undefined) throw new Error('setattr op requires attrs')
        await dispatch('setattr', path, [], attrs as Record<string, unknown>)
        return undefined
      }
      case 'readdir':
        // The names as the door merged them, nothing resolved: the
        // runtime door (`RuntimeVFS.readdir`) stats each entry and
        // marks the links, so a row is built in one tier and in one
        // shape in both languages.
        return ((await dispatch('readdir', path)) as string[] | null) ?? []
      case 'getxattr':
        return await dispatch('getxattr', path, [], {
          name: dst ?? '',
          nofollow: attrs?.nofollow === true,
        })
      case 'listxattr':
        return await dispatch('listxattr', path, [], { nofollow: attrs?.nofollow === true })
      case 'setxattr':
        await dispatch('setxattr', path, [], {
          name: dst ?? '',
          value: bytes ?? new Uint8Array(),
          create: attrs?.create === true,
          replace: attrs?.replace === true,
          nofollow: attrs?.nofollow === true,
        })
        return undefined
      case 'removexattr':
        await dispatch('removexattr', path, [], {
          name: dst ?? '',
          nofollow: attrs?.nofollow === true,
        })
        return undefined
    }
  }
}
