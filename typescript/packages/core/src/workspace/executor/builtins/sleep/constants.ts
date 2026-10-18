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

// The NUMBER half of GNU's `NUMBER[SUFFIX]`: finite non-negative decimals
// only ("0", "0.2", ".5", "1.", "+1", "1e-3"). GNU sleep additionally accepts
// "inf" and sleeps forever; an agent shell must never hang, so non-finite
// intervals are rejected (deliberate divergence). The regex also keeps
// Python/TypeScript parsing identical: Number() alone would accept "0x10",
// "Infinity", and the empty string that float() rejects, and float() accepts
// "inf", "nan", and "1_0".
export const SLEEP_INTERVAL = /^\+?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/

// The SUFFIX half, and what each one multiplies the number by. GNU takes at
// most one suffix letter after the number, lowercase only. Measured on
// coreutils 9.7: `sleep 0.005m` takes 0.3s, while `sleep 0S`, `sleep 0ss` and
// `sleep s` are all `invalid time interval`.
export const SLEEP_SUFFIXES: Readonly<Record<string, number>> = Object.freeze({
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 60 * 60 * 24,
})
