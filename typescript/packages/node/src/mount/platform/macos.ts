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

const MACOS_METADATA: ReadonlySet<string> = new Set([
  '.DS_Store',
  '.Spotlight-V100',
  '.fseventsd',
  '.Trashes',
])

export function isMacosMetadata(name: string): boolean {
  return MACOS_METADATA.has(name) || name.startsWith('._')
}
