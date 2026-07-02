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
import type { Session } from '../session/session.ts'
import type { ProvisionNodeFn } from './pipes.ts'

async function planBody(
  provisionNode: ProvisionNodeFn,
  body: readonly unknown[],
  session: Session,
): Promise<ProvisionResult> {
  const children: ProvisionResult[] = []
  for (const cmd of body) children.push(await provisionNode(cmd, session))
  if (children.length === 0) return new ProvisionResult({ precision: Precision.EXACT })
  if (children.length === 1) {
    const first = children[0]
    if (first === undefined) return new ProvisionResult({ precision: Precision.EXACT })
    return first
  }
  return rollupList(';', children)
}

/**
 * Plan an if: branches bracket as alternatives. Taking branch i
 * evaluates conditions 1..i plus body i, so each alternative sums its
 * condition ladder with its body. The else (or, without one, the
 * fall-through) still pays every condition.
 */
export async function handleIfProvision(
  provisionNode: ProvisionNodeFn,
  branches: readonly [unknown, readonly unknown[]][],
  elseBody: readonly unknown[] | null,
  session: Session,
): Promise<ProvisionResult> {
  const condCosts: ProvisionResult[] = []
  const children: ProvisionResult[] = []
  for (const [condition, body] of branches) {
    condCosts.push(await provisionNode(condition, session))
    const bodyResult = await planBody(provisionNode, body, session)
    children.push(rollupList(';', [...condCosts, bodyResult]))
  }
  const elseResult =
    elseBody !== null
      ? await planBody(provisionNode, elseBody, session)
      : new ProvisionResult({ precision: Precision.EXACT })
  children.push(rollupList(';', [...condCosts, elseResult]))
  return rollupList('||', children)
}

export async function handleForProvision(
  provisionNode: ProvisionNodeFn,
  body: readonly unknown[],
  n: number,
  session: Session,
): Promise<ProvisionResult> {
  const result = await planBody(provisionNode, body, session)
  return result.scaled(n, 'for')
}

export async function handleWhileProvision(
  provisionNode: ProvisionNodeFn,
  body: readonly unknown[],
  session: Session,
): Promise<ProvisionResult> {
  const result = await planBody(provisionNode, body, session)
  result.precision = Precision.UNKNOWN
  return result
}
