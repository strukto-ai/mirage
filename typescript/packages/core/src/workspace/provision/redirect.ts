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

import { rollupList } from '../../provision/rollup.ts'
import { Precision, ProvisionResult } from '../../provision/types.ts'
import { RedirectKind } from '../../shell/types.ts'
import type { PathSpec } from '../../types.ts'
import type { MountRegistry } from '../mount/registry.ts'
import { handleCommandProvision } from './command.ts'
import type { Session } from '../session/session.ts'
import type { ProvisionNodeFn } from './pipes.ts'

/**
 * Plan a redirect: the inner command plus the redirect I/O.
 *
 * A `< file` source is read fully, so it is planned as a cat of the
 * source (exact when the size resolves). A `>`/`>>` target writes the
 * inner command's stdout, whose size is only knowable when the inner
 * read total is: the write is bracketed 0..inner read high as a
 * RANGE, or UNKNOWN when the inner plan has no usable ceiling. stderr
 * redirects, fd duplications, /dev targets, and heredocs are filtered
 * out by the caller and cost nothing.
 */
export async function handleRedirectProvision(
  provisionNode: ProvisionNodeFn,
  registry: MountRegistry,
  command: unknown,
  targets: readonly [RedirectKind, PathSpec][],
  session: Session,
): Promise<ProvisionResult> {
  const inner = await provisionNode(command, session)
  if (targets.length === 0) return inner
  const children: ProvisionResult[] = [inner]
  for (const [kind, target] of targets) {
    if (kind === RedirectKind.STDIN) {
      children.push(await handleCommandProvision(registry, ['cat', target], session))
      continue
    }
    if (inner.networkReadHigh > 0) {
      children.push(
        new ProvisionResult({
          networkWriteLow: 0,
          networkWriteHigh: inner.networkReadHigh,
          precision: Precision.RANGE,
        }),
      )
    } else {
      children.push(new ProvisionResult({ precision: Precision.UNKNOWN }))
    }
  }
  return rollupList(';', children)
}
