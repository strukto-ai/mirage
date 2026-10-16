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
import { compareCodePoints } from '../utils/sort.ts'
import { captureSessionContext } from '../context/session_context.ts'
import { captureExecutionContext } from '../execution/context.ts'
import type { OpKwargs, SessionView } from '../view/types.ts'
import { isGlob, showHead } from '../utils/hidden.ts'
import { PathSpec } from '../types.ts'
import { ContextScope } from '../utils/context_scope.ts'
import type { MountResolver } from './resolver.ts'
import type { BridgeDispatchFn } from './types.ts'
import type { Files } from '../workspace/files.ts'
import type { SessionState } from '../workspace/session/session.ts'

/** Local workspace entry points captured for one execution, never guest
 * globals. `vfs` is the session's files, whose links a guest's path resolves
 * through; null outside a workspace. */
export interface RuntimeContext {
  readonly binding: WorkspaceBinding
  readonly dispatch: BridgeDispatchFn
  readonly resolver: MountResolver
  readonly vfs: Files | null
  readonly sessionView: SessionView | null
  readonly cwd: PathSpec
  readonly env: Readonly<Record<string, string>>
  readonly scope: ContextScope
  readonly processes: ProcessView | null
  readonly restrictedMounts?: readonly string[]
}

/** Live workspace connection; capture creates views scoped to one execution. */
export class WorkspaceBinding {
  /**
   * The last three serve an adapter that serves the mounts as files (a
   * sandbox's SFTP), each null outside a workspace.
   *
   * @param files the workspace's `ws.vfs`.
   * @param getSession its live session by id.
   * @param mountPrefixes every prefix a sandbox may be told of, whatever
   *   the session hides.
   */
  constructor(
    readonly dispatch: BridgeDispatchFn,
    readonly resolver: MountResolver,
    private readonly context?: (binding: WorkspaceBinding) => RuntimeContext,
    readonly files: Files | null = null,
    readonly getSession: ((sessionId: string) => SessionState) | null = null,
    readonly mountPrefixes: (() => string[]) | null = null,
  ) {}

  capture(): RuntimeContext {
    return this.context === undefined ? captureBinding(this) : this.context(this)
  }
}

/** Map restrictions to owning mounts, not ancestors whose trees contain another mount. */
export function restrictedMountsFor(session: SessionState, prefixes: readonly string[]): string[] {
  const hidden = session.visibility.paths
  const entries = [...(hidden?.paths ?? []), ...(hidden?.patterns ?? [])]
  entries.push(
    ...(session.visibility.shown?.entries ?? [])
      .filter((e) => e.mode !== null && e.mode !== 'exec')
      .map((e) => e.path),
  )
  for (const rule of [...(session.commands?.ask ?? []), ...(session.commands?.deny ?? [])]) {
    entries.push(...(rule.paths?.length ? rule.paths : rule.mount ? [rule.mount] : []))
  }
  for (const [prefix, mode] of session.mountModes ?? []) if (mode !== 'exec') entries.push(prefix)
  const mounts = new Map(prefixes.map((p) => [p.replace(/\/+$/, '') || '/', p]))
  if (!mounts.has('/')) mounts.set('/', '/')
  const restricted = new Set<string>()
  for (const entry of entries) {
    const head = isGlob(entry) && !entry.includes('/') ? '/' : showHead(entry)
    const owners = [...mounts.keys()].filter(
      (p) => p === '/' || head === p || head.startsWith(p + '/'),
    )
    owners.sort((a, b) => b.length - a.length)
    restricted.add(mounts.get(owners[0] ?? '/') ?? '/')
    for (const [path, prefix] of mounts)
      if (head === '/' || path.startsWith(head + '/')) restricted.add(prefix)
  }
  return [...restricted].sort(compareCodePoints)
}

/** Pin callback attribution without copying authoritative workspace state. */
export function captureBinding(
  binding: WorkspaceBinding,
  views: {
    vfs?: Files
    sessionView?: SessionView
    processes?: ProcessView
    cwd?: PathSpec
    env?: Readonly<Record<string, string>>
    restrictedMounts?: readonly string[]
    // The bridge bound to the session the views describe; the binding's
    // own serves a context captured with no session named.
    dispatch?: BridgeDispatchFn
  } = {},
  scope = new ContextScope([...captureSessionContext(), captureExecutionContext()]),
): RuntimeContext {
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
          cwd: scope.wrap(session.cwd.bind(session)),
        }
  return Object.freeze({
    binding,
    dispatch: scope.wrap(views.dispatch ?? binding.dispatch),
    resolver: {
      prefixes: scope.wrap(() => binding.resolver.prefixes()),
      ownerOf: scope.wrap((path: string) => binding.resolver.ownerOf(path)),
      linkChildren: scope.wrap((path: string) => binding.resolver.linkChildren(path)),
    },
    vfs: views.vfs ?? null,
    sessionView,
    processes: views.processes ?? null,
    restrictedMounts: Object.freeze(views.restrictedMounts ?? []),
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
 * matching Python's `RuntimeFiles.read`.
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
        if (attrs?.direct === true) kwargs.direct = true
        return (await dispatch('read', path, [], kwargs)) as Uint8Array
      }
      case 'write': {
        if (attrs?.admitOnly === true) {
          await dispatch('write', path, [], { admit_only: true })
          return undefined
        }
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
        // The mount's own row, nothing projected: the file adapter
        // builds the one VFSStat both languages read, so the two
        // tiers cannot drift into two translations of one fact.
        // `nofollow` is the caller's lstat; `admitOnly` checks a guest's
        // requested alias against command rules without backend I/O.
        return await dispatch('stat', path, [], {
          ...(attrs?.nofollow === true ? { nofollow: true } : {}),
          ...(attrs?.admitOnly === true ? { admit_only: true } : {}),
        })
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
        await dispatch('rename', path, [PathSpec.fromStrPath(dst, undefined, '/')])
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
        // The names as the dispatcher merged them, nothing resolved: the
        // file adapter (`RuntimeFiles.readdir`) stats each entry and
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
