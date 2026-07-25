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

export function scoreFromDistance(value: unknown): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return '0.00'
  return Math.max(0, 1 - value).toFixed(2)
}

export function formatScore(value: unknown): string | null {
  if (typeof value !== 'number' || Number.isNaN(value)) return null
  return value.toFixed(2)
}
