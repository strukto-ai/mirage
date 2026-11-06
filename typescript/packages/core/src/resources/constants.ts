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

export const ENTRY_KINDS: readonly EntryKind[] = ['vfs', 'cli', 'runtime', 'store']

/** The one scope a local daemon serves; the console builds a store per team. */
export const DEFAULT_SCOPE = 'local'

/** A name the console accepts, which is also safe as a file name. */
export const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/

/** The folder deleted templates wait in until restored. */
export const DELETED_TEMPLATES = '.deleted/template'

/** Each kind as its messages name it. */
export const NOUN: Readonly<Record<ResourceKind, string>> = {
  vfs: 'VFS',
  cli: 'CLI',
  runtime: 'runtime',
  store: 'secret store',
  policy: 'policy',
  template: 'template',
}
