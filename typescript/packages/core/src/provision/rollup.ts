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

import { combineAlternative, combineSum, Precision, ProvisionResult } from './types.ts'

/**
 * Aggregate plan results for a pipe (all stages run). A stage downstream of
 * an UNKNOWN stage cannot be trusted either (its input volume is
 * unknowable), so its precision is degraded before the field-wise sum.
 */
export function rollupPipe(children: ProvisionResult[]): ProvisionResult {
  let unknownSeen = false
  for (const child of children) {
    if (unknownSeen) {
      child.precision = Precision.UNKNOWN
    } else if (child.precision === Precision.UNKNOWN) {
      unknownSeen = true
    }
  }
  return combineSum('|', children)
}

/**
 * Aggregate plan results for ;, &&, ||: sums when every command runs, a
 * min/max envelope for || where only one branch runs.
 */
export function rollupList(op: string, children: ProvisionResult[]): ProvisionResult {
  if (op === '||') {
    return combineAlternative(op, children)
  }
  return combineSum(op, children)
}
