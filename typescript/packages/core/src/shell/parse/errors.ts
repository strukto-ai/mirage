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

import type { ReaderToken } from './types.ts'

/** An error bash reports while reading a line, in its own words: the lines
 * without a prefix, the status it refuses the line with, the text it names
 * (empty at the end of input), where that text sits, and whether the input
 * ended inside a construct. Mirrors Python's ReaderRefusal. */
export class ReaderRefusal extends Error {
  constructor(
    readonly lines: string[],
    public status: number,
    readonly offending: string,
    readonly start: number,
    readonly end: number,
    readonly eof: boolean,
  ) {
    super(lines.join('\n'))
    this.name = 'ReaderRefusal'
  }
}

/** A `[[ ]]` expression bash refuses, before the line naming where: its own
 * diagnostic lines, the token it stopped at, and whether the input ended
 * inside the expression. Mirrors Python's TestFailure. */
export class TestFailure extends Error {
  constructor(
    readonly lines: string[],
    readonly token: ReaderToken,
    readonly eof = false,
  ) {
    super(lines.join('\n'))
    this.name = 'TestFailure'
  }
}
