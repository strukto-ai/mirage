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

export const Precision = Object.freeze({
  EXACT: 'exact',
  RANGE: 'range',
  UNKNOWN: 'unknown',
  UPPER_BOUND: 'upper_bound',
} as const)

export type Precision = (typeof Precision)[keyof typeof Precision]

export interface ProvisionResultInit {
  op?: string | null
  command?: string | null
  children?: ProvisionResult[]
  networkReadLow?: number
  networkReadHigh?: number
  cacheReadLow?: number
  cacheReadHigh?: number
  networkWriteLow?: number
  networkWriteHigh?: number
  cacheWriteLow?: number
  cacheWriteHigh?: number
  readOps?: number
  cacheHits?: number
  precision?: Precision
  estimatedCostUsd?: number | null
}

export class ProvisionResult {
  op: string | null
  command: string | null
  children: ProvisionResult[]
  networkReadLow: number
  networkReadHigh: number
  cacheReadLow: number
  cacheReadHigh: number
  networkWriteLow: number
  networkWriteHigh: number
  cacheWriteLow: number
  cacheWriteHigh: number
  readOps: number
  cacheHits: number
  precision: Precision
  estimatedCostUsd: number | null

  constructor(init: ProvisionResultInit = {}) {
    this.op = init.op ?? null
    this.command = init.command ?? null
    this.children = init.children ?? []
    this.networkReadLow = init.networkReadLow ?? 0
    this.networkReadHigh = init.networkReadHigh ?? 0
    this.cacheReadLow = init.cacheReadLow ?? 0
    this.cacheReadHigh = init.cacheReadHigh ?? 0
    this.networkWriteLow = init.networkWriteLow ?? 0
    this.networkWriteHigh = init.networkWriteHigh ?? 0
    this.cacheWriteLow = init.cacheWriteLow ?? 0
    this.cacheWriteHigh = init.cacheWriteHigh ?? 0
    this.readOps = init.readOps ?? 0
    this.cacheHits = init.cacheHits ?? 0
    this.precision = init.precision ?? Precision.EXACT
    this.estimatedCostUsd = init.estimatedCostUsd ?? null
  }

  private fmtRange(low: number, high: number): string {
    return low === high ? String(low) : `${String(low)}-${String(high)}`
  }

  get networkRead(): string {
    return this.fmtRange(this.networkReadLow, this.networkReadHigh)
  }
  get cacheRead(): string {
    return this.fmtRange(this.cacheReadLow, this.cacheReadHigh)
  }
  get networkWrite(): string {
    return this.fmtRange(this.networkWriteLow, this.networkWriteHigh)
  }
  get cacheWrite(): string {
    return this.fmtRange(this.cacheWriteLow, this.cacheWriteHigh)
  }
}
