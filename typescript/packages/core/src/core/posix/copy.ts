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

import { singleQuote } from '../../utils/quote.ts'
import { COPIED, CP } from './constants.ts'

/**
 * The `cp -RL` that copies a directory tree onto a fresh name, following
 * links as a listing does, and says `copied` once it has.
 *
 * @param src the directory, where the files are.
 * @param dst the copy's path there.
 */
export function copyTreeCommand(src: string, dst: string): string {
  return `${CP} ${singleQuote(src)} ${singleQuote(dst)} && echo ${COPIED.trim()}`
}
