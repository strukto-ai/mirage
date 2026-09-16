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

import { encodeText } from '../shell/bytes.ts'

// The seven C escapes gnulib spells by name, plus the two printable
// characters it still escapes because they would otherwise close or
// confuse the quotes it wrapped the word in. Every other byte outside
// 0x20-0x7e becomes three octal digits.
const QUOTE_ESCAPES = new Map<string, string>([
  ['\x07', '\\a'],
  ['\x08', '\\b'],
  ['\t', '\\t'],
  ['\n', '\\n'],
  ['\x0b', '\\v'],
  ['\f', '\\f'],
  ['\r', '\\r'],
  ["'", "\\'"],
  ['\\', '\\\\'],
])

// One word as gnulib's `quote()` renders it inside a diagnostic.
//
// Every GNU coreutils diagnostic that names a word passes it through
// gnulib's quotearg in `locale_quoting_style`, which in the C locale wraps
// it in single quotes and escapes what would be unreadable inside them.
// This is the body only; the quotes belong to the message templates,
// because a few clauses spell them differently (`cut` writes
// `invalid field value '<w>'` with no colon before the quote).
//
// ONE rule, not one per command. It was derived from all 255 reachable
// byte values in each of `nl`, `expand`, `shuf`, `cut` and `expr`, and all
// five agree byte for byte, which is what makes this a shared leaf rather
// than a copy in each command.
//
// It sits directly under `commands/` because both halves of the tree need
// it: every builtin that refuses a flag value, and the shared ARGMATCH
// renderer in `commands/spec/usage.ts`. A leaf beside `commands/errors.ts`
// is reachable from `spec` and from `builtin` alike, where the old home
// under `commands/builtin/utils/` would have made `spec` import `builtin`
// -- the one direction nothing in this tree takes.
//
// The rule is per byte, which is why this takes a byte view: a two-byte
// character is two octal escapes (`expr '(' <e-acute>` names `\303\251`,
// not the character), and a byte above 0x7f is not printable in the C
// locale. Callers holding an ordinary string want `quoteText`.
//
// Not every quoted word goes through this. getopt's own
// `unrecognized option '<w>'` prints `argv[optind]` with a plain `%s`, so
// it carries the raw bytes and must NOT be routed here.
//
// `quote_word` in quote.py is the twin.
export function quoteWord(view: string): string {
  let out = ''
  for (const ch of view) {
    const named = QUOTE_ESCAPES.get(ch)
    if (named !== undefined) {
      out += named
    } else if (ch >= ' ' && ch <= '~') {
      out += ch
    } else {
      out += '\\' + ch.charCodeAt(0).toString(8).padStart(3, '0')
    }
  }
  return out
}

// `quoteWord` for a caller holding an ordinary string rather than the byte
// view expr's parser runs on.
//
// The commands that refuse a flag value hold it as a plain string, so they
// need the encode first: the rule counts bytes, and `é` must render as two
// octal escapes rather than one. `encodeText` rather than `TextEncoder`,
// because a raw byte reaches a command as its U+DCxx sentinel and
// `TextEncoder` would write that as U+FFFD.
//
// `quote_text` in quote.py is the twin.
export function quoteText(text: string): string {
  const raw = encodeText(text)
  let view = ''
  for (const byte of raw) view += String.fromCharCode(byte)
  return quoteWord(view)
}
