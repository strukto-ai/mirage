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

// Bash arithmetic tokens: integer literals (decimal/hex/octal), variable
// names, then operators longest-first so `<<=` never lexes as `<<` + `=`.
export const ARITH_TOKEN = new RegExp(
  [
    '(0[xX][0-9a-fA-F]+|\\d+)',
    '([A-Za-z_]\\w*)',
    '(<<=|>>=|\\*\\*|\\+\\+|--|<<|>>|<=|>=|==|!=|&&|\\|\\||\\+=|-=|\\*=|/=|%=|&=|\\^=|\\|=|[-+*/%<>=!~&|^?:(),])',
    '(\\s+)',
    '(.)',
  ].join('|'),
  'g',
)

export const ARITH_NAME = /^[A-Za-z_]\w*$/

export const ARITH_ASSIGN_OPS = new Set([
  '=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '<<=',
  '>>=',
  '&=',
  '^=',
  '|=',
])

// Recursion budget for variables holding expressions (`x="1+2"; $((x))`),
// mirroring bash's expression recursion limit.
export const ARITH_MAX_DEPTH = 16
