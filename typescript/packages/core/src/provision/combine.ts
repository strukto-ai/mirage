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

import type { ProvisionResultInit } from './types.ts'
import { Precision, ProvisionResult } from './types.ts'

const COMBINE_FIELDS = [
  'networkReadLow',
  'networkReadHigh',
  'cacheReadLow',
  'cacheReadHigh',
  'networkWriteLow',
  'networkWriteHigh',
  'cacheWriteLow',
  'cacheWriteHigh',
  'readOps',
  'cacheHits',
] as const

const LOW_FIELDS = COMBINE_FIELDS.filter((f) => !f.endsWith('High'))
const HIGH_FIELDS = COMBINE_FIELDS.filter((f) => f.endsWith('High'))

const PRECISION_ORDER: Record<Precision, number> = {
  [Precision.EXACT]: 0,
  [Precision.RANGE]: 1,
  [Precision.UPPER_BOUND]: 2,
  [Precision.UNKNOWN]: 3,
}

/**
 * Multiply every combinable field by an iteration count (for-loops).
 * Precision is carried over; estimatedCostUsd scales with the count.
 */
export function scaled(
  result: ProvisionResult,
  n: number,
  command: string | null = null,
): ProvisionResult {
  const init: ProvisionResultInit = { command, precision: result.precision }
  for (const f of COMBINE_FIELDS) init[f] = result[f] * n
  if (result.estimatedCostUsd !== null) init.estimatedCostUsd = result.estimatedCostUsd * n
  return new ProvisionResult(init)
}

/**
 * Worst precision across children (EXACT < RANGE < UPPER_BOUND < UNKNOWN).
 * Missing knowledge is carried by precision, not by null fields: when this
 * returns UNKNOWN the combined numeric totals are lower bounds.
 */
function combinedPrecision(children: readonly ProvisionResult[]): Precision {
  let worst: Precision = Precision.EXACT
  for (const c of children) {
    if (PRECISION_ORDER[c.precision] > PRECISION_ORDER[worst]) worst = c.precision
  }
  return worst
}

/**
 * Sum child costs; null unless every child has one. estimatedCostUsd is the
 * only nullable field, so a single costless child makes the total
 * unknowable rather than silently undercounted.
 */
function combinedCost(children: readonly ProvisionResult[]): number | null {
  const costs = children.map((c) => c.estimatedCostUsd).filter((c): c is number => c !== null)
  if (children.length > 0 && costs.length === children.length) {
    return costs.reduce((a, b) => a + b, 0)
  }
  return null
}

/** Combine children that all run: field-wise sums (|, ;, &&). */
export function combineSum(op: string, children: ProvisionResult[]): ProvisionResult {
  const init: ProvisionResultInit = {
    op,
    children,
    precision: combinedPrecision(children),
    estimatedCostUsd: combinedCost(children),
  }
  for (const f of COMBINE_FIELDS) {
    init[f] = children.reduce((acc, c) => acc + c[f], 0)
  }
  return new ProvisionResult(init)
}

/**
 * Combine children where only one runs (||): best/worst envelope. Lows and
 * op counters take the cheapest child (min), highs the most expensive
 * (max), so the result brackets every possible branch. Cost is the
 * cheapest child's when all children have one, else null.
 */
export function combineAlternative(op: string, children: ProvisionResult[]): ProvisionResult {
  const init: ProvisionResultInit = { op, children }
  for (const f of LOW_FIELDS) {
    init[f] = children.length === 0 ? 0 : Math.min(...children.map((c) => c[f]))
  }
  for (const f of HIGH_FIELDS) {
    init[f] = children.length === 0 ? 0 : Math.max(...children.map((c) => c[f]))
  }
  let cost = combinedCost(children)
  if (cost !== null) {
    cost = Math.min(
      ...children.map((c) => c.estimatedCostUsd).filter((c): c is number => c !== null),
    )
  }
  init.estimatedCostUsd = cost
  init.precision =
    combinedPrecision(children) === Precision.UNKNOWN ? Precision.UNKNOWN : Precision.RANGE
  return new ProvisionResult(init)
}
