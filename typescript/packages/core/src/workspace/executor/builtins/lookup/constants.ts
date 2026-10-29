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

import { NameKind } from './types.ts'

export const WHICH_USAGE = 'which: usage: which [-as] name [name ...]\n'

// The words each builtin accepts, as bash's usage line spells them.
export const TYPE_OPTIONS = 'afptP'
export const WHICH_OPTIONS = 'as'

export const DESCRIPTIONS: Readonly<Partial<Record<NameKind, string>>> = Object.freeze({
  [NameKind.ALIAS]: 'an alias',
  [NameKind.KEYWORD]: 'a shell keyword',
  [NameKind.FUNCTION]: 'a function',
  [NameKind.BUILTIN]: 'a shell builtin',
})
