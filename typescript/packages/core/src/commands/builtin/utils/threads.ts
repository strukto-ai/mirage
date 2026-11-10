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

const LEADING_COUNT = /^\s*([0-9]+)\s*(?:,|$)/

function threadCount(value: string | undefined): number | null {
  const count = value === undefined ? 0 : Number(LEADING_COUNT.exec(value)?.[1] ?? 0)
  return count > 0 ? count : null
}

/** The processors a program may use, under the OpenMP limits. */
export function threadLimit(env: Readonly<Record<string, string>>, cpus: number): number {
  const count = threadCount(env.OMP_NUM_THREADS) ?? cpus
  const limit = threadCount(env.OMP_THREAD_LIMIT)
  return limit === null ? count : Math.min(count, limit)
}
