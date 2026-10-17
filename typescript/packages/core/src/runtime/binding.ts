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

import type { Context } from '../commands/config.ts'
import { compareCodePoints } from '../utils/sort.ts'
import { captureSessionContext } from '../context/session_context.ts'
import { captureExecutionContext } from '../execution/context.ts'
import type { OpKwargs } from '../view/types.ts'
import { isGlob, showHead } from '../utils/hidden.ts'
import { PathSpec } from '../types.ts'
import { ContextScope } from '../utils/context_scope.ts'
import type { MountResolver } from './resolver.ts'
import type { BridgeDispatchFn, DispatchFn } from './types.ts'
import { Files } from '../workspace/files.ts'
import type { SessionState } from '../workspace/session/session.ts'

/** Local workspace entry points captured for one execution, never guest
 * globals. `ctx` is the same `Context` a command or CLI gets: its `vfs` is
 * the session's files over the binding's dispatch, so a guest's calls are
 * the program's own. */
export interface RuntimeContext {
  readonly binding: WorkspaceBinding
  readonly resolver: MountResolver
  readonly scope: ContextScope
  readonly ctx: Context
  readonly restrictedMounts?: readonly string[]
}

/** Live workspace connection; capture creates views scoped to one execution. */
export class WorkspaceBinding {
  /**
   * @param dispatch a program's own file call, its gate included; null
   *   over a guest bridge alone (`overBridge`).
   * @param resolver the routing table.
   * @param context the capture for one execution; `captureBinding` when
   *   absent.
   * @param files the workspace's `ws.vfs`, for an adapter that serves the
   *   mounts as files (a sandbox's SFTP); null outside a workspace.
   * @param getSession its live session by id; null outside a workspace.
   * @param mountPrefixes every prefix a sandbox may be told of, whatever
   *   the session hides; null outside a workspace.
   * @param bridge the guest bridge a run with no files rides.
   */
  constructor(
    readonly dispatch: DispatchFn | null,
    readonly resolver: MountResolver,
    private readonly context?: (binding: WorkspaceBinding) => RuntimeContext,
    readonly files: Files | null = null,
    readonly getSession: ((sessionId: string) => SessionState) | null = null,
    readonly mountPrefixes: (() => string[]) | null = null,
    readonly bridge: BridgeDispatchFn | null = null,
  ) {}

  /**
   * A binding whose file calls ride a guest bridge (the Pyodide worker's,
   * across `postMessage`) rather than a dispatcher.
   *
   * @param bridge the guest bridge.
   * @param resolver the routing table.
   * @param context the capture for one execution; `captureBinding` when
   *   absent.
   */
  static overBridge(
    bridge: BridgeDispatchFn,
    resolver: MountResolver,
    context?: (binding: WorkspaceBinding) => RuntimeContext,
  ): WorkspaceBinding {
    return new WorkspaceBinding(null, resolver, context, null, null, null, bridge)
  }

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

/**
 * Pin callback attribution without copying authoritative workspace state.
 *
 * @param binding the workspace connection.
 * @param views the session's context, its restricted mounts, and the
 *   dispatch bound to that session (the binding's own when absent).
 * @param scope the context the entry points replay.
 */
export function captureBinding(
  binding: WorkspaceBinding,
  views: {
    ctx?: Partial<Context>
    restrictedMounts?: readonly string[]
    dispatch?: DispatchFn
  } = {},
  scope = new ContextScope([...captureSessionContext(), captureExecutionContext()]),
): RuntimeContext {
  const given = views.dispatch ?? binding.dispatch
  const dispatch = given === null ? null : scope.wrap(given)
  const vfs =
    dispatch === null
      ? undefined
      : (views.ctx?.vfs?.over(dispatch) ??
        new Files(dispatch, null, null, () => null, { ledger: false }))
  const session = views.ctx?.session
  const wrapped =
    session === undefined
      ? undefined
      : {
          get: scope.wrap(session.get.bind(session)),
          snapshot: scope.wrap(session.snapshot.bind(session)),
          set: scope.wrap(session.set.bind(session)),
          unset: scope.wrap(session.unset.bind(session)),
          mark: scope.wrap(session.mark.bind(session)),
          isReadonly: scope.wrap(session.isReadonly.bind(session)),
          profile: scope.wrap(session.profile.bind(session)),
          cwd: scope.wrap(session.cwd.bind(session)),
          sessionId: session.sessionId,
          access: scope.wrap(session.access.bind(session)),
        }
  const rest: Partial<Context> = { ...views.ctx }
  delete rest.vfs
  return Object.freeze({
    binding,
    resolver: new ScopedResolver(binding.resolver, scope),
    restrictedMounts: Object.freeze(views.restrictedMounts ?? []),
    ctx: Object.freeze({
      stdin: null,
      flags: {},
      ...rest,
      ...(vfs !== undefined ? { vfs } : {}),
      cwd: views.ctx?.cwd ?? PathSpec.fromStrPath('/'),
      env: Object.freeze({ ...views.ctx?.env }),
      ...(wrapped === undefined ? {} : { session: wrapped }),
    }),
    scope,
  })
}

/** Delegate every routing question under the captured context. */
export class ScopedResolver implements MountResolver {
  /**
   * @param resolver the routing table asked.
   * @param scope the context each question replays.
   */
  constructor(
    private readonly resolver: MountResolver,
    private readonly scope: ContextScope,
  ) {}

  prefixes(): string[] {
    return this.scope.call(() => this.resolver.prefixes())
  }

  ownerOf(path: string): string | null {
    return this.scope.call(() => this.resolver.ownerOf(path))
  }

  linkChildren(directory: string): Set<string> {
    return this.scope.call(() => this.resolver.linkChildren(directory))
  }
}

/**
 * The bridge a runtime's file I/O rides, over a dispatch shaped like
 * `Workspace.dispatch` (name, string path, positional args, kwargs): the
 * run's files for a guest (`RuntimeFiles.of`), `ws.vfs.dispatch` for
 * node's patched `fs`. A read is the rendered one unless its `raw` attr asks for the
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
