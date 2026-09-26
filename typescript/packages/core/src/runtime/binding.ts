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

import type { ProcessView } from '../process/types.ts'
import { captureSessionContext } from '../context/session_context.ts'
import { captureRecordingContext } from '../observe/context.ts'
import type { NamespaceView, SessionView } from '../ops/types.ts'
import { PathSpec } from '../types.ts'
import { ContextScope } from '../utils/context_scope.ts'
import type { MountResolver } from './resolver.ts'
import type { BridgeDispatchFn, RuntimeContext } from './types.ts'

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
  scope = new ContextScope([...captureSessionContext(), ...captureRecordingContext()]),
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
