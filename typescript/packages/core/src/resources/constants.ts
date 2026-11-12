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

import type { EntryKind, ResourceKind } from './types.ts'

export const ENTRY_KINDS: readonly EntryKind[] = ['vfs', 'cli', 'runtime', 'machine', 'store']

/** The one scope a local daemon serves; a hosted server keeps one per team. */
export const DEFAULT_SCOPE = 'local'

/** A saved config's name, which is also safe as a file name. */
export const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/

/** A saved policy's name: a file name mirage reads as Python. */
export const POLICY_NAME = /^[a-z0-9][a-z0-9._-]{0,59}\.py$/

/** The source a config names a saved field through: `{from: strukto, ref, key}`. */
export const STRUKTO = 'strukto'

/** Each kind as its messages name it. */
export const NOUN: Readonly<Record<ResourceKind, string>> = {
  vfs: 'VFS',
  cli: 'CLI',
  runtime: 'runtime',
  machine: 'machine',
  store: 'secret store',
  policy: 'policy',
  template: 'template',
}
