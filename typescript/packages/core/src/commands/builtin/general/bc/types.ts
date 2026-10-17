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

export interface BcNumber {
  readonly coefficient: bigint
  readonly scale: number
}

export interface MathInterval {
  readonly lower: BcNumber
  readonly upper: BcNumber
  readonly lowerOpen: boolean
  readonly upperOpen: boolean
}

export interface BcState {
  scale: number
  mathMode: boolean
  ibase: number
  obase: number
  last: BcNumber
  variables: Map<string, BcNumber>
  warnings: string[]
}

export interface BcStatement {
  readonly text: string
  readonly lines: readonly number[]
  readonly incompleteLine: number
  readonly execute: boolean
}
