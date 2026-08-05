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

import { type Limit, type PathSpec } from '../types.ts'
import { PolicyDenied } from './errors.ts'
import type { Policies } from './policies.ts'
import type { Deny, ExecuteContext, ExecuteResultContext, Route } from './types.ts'

/**
 * Fire preExecute before a typed line runs. Returns the first Deny
 * (the line is refused, exit 126) or the first Route (the line is
 * placed on that runtime); both null passes the line to entry scripts
 * and static bindings.
 */
export async function preExecuteGate(
  policies: Policies,
  ctx: ExecuteContext,
): Promise<[Deny | null, Route | null]> {
  if (!policies.wants('preExecute')) return [null, null]
  return policies.preExecute(ctx)
}

/**
 * Fire preOps at the op door; a Deny becomes a PolicyDenied (EACCES).
 * The one seam helper the dispatcher calls, so a refusal is identical
 * however the mount is reached: shell internals, programmatic access,
 * FUSE, and the warm cache all pass through it.
 */
export async function preOpsGate(
  policies: Policies,
  op: string,
  path: PathSpec,
  write: boolean,
  prefix: string,
): Promise<void> {
  if (!policies.wants('preOps')) return
  const deny = await policies.preOps({ op, path, write, prefix })
  if (deny !== null) {
    throw new PolicyDenied(deny.message.replace(/\n$/, ''), path.virtual)
  }
}

/**
 * Fire postOps at the op door; a Deny suppresses the result. Returns
 * the merged Limit bound (tightest per field across every opining
 * policy) for the door to apply to a byte-producing result, or null
 * when no policy bounds this op.
 */
export async function postOpsGate(
  policies: Policies,
  op: string,
  path: PathSpec,
  write: boolean,
  prefix: string,
  result: unknown,
): Promise<Limit | null> {
  if (!policies.wants('postOps')) return null
  const [deny, bound] = await policies.postOps({ op, path, write, prefix, result })
  if (deny !== null) {
    throw new PolicyDenied(deny.message.replace(/\n$/, ''), path.virtual)
  }
  return bound
}

/**
 * Fire postExecute at the workspace boundary. Returns the fail-closed
 * Deny (a throwing policy) if any, and the merged Limit bound for the
 * boundary to enforce on the line's output stream.
 */
export async function postExecuteGate(
  policies: Policies,
  ctx: ExecuteResultContext,
): Promise<[Deny | null, Limit | null]> {
  if (!policies.wants('postExecute')) return [null, null]
  return policies.postExecute(ctx)
}
