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

import { openStreamSync } from '../rs/stream.ts'
import { decodeText, encodeText } from '../shell/bytes.ts'

// '#' starts a comment and '~' starts a home-directory expansion, but
// only as the first character of a word, so GNU quotes them there alone.
export const LEADING_SPECIAL = new Set('#~')

// What rules out the "name" form for a name holding a single quote.
// Narrower than the trigger set: a space and a ':' are harmless inside
// double quotes, while the conditional characters #, ~, { and } lose their
// position rule and always rule it out.
export const DQ_BLOCKERS = new Set('!"#$&()*;<=>?[\\^`{|}~')

export const NAMED_ESCAPES = new Map([
  ['\x07', 'a'],
  ['\b', 'b'],
  ['\t', 't'],
  ['\n', 'n'],
  ['\v', 'v'],
  ['\f', 'f'],
  ['\r', 'r'],
])

// The commands whose operand mirage reports shell-quoted, each one probed
// against its own GNU original on debian:stable-slim. GNU picks the policy
// per diagnostic, not per command family: cat/wc/cut and most of the read
// family quote only when the name needs it (the shell-escape quoting style),
// while head/tail/tac/fmt/split/csplit/truncate/strings quote always and
// word the line differently ("cannot open X for reading"). Those say it in
// GNU's words (FAILURE_WORDING in errors.ts). For the rest
// mirage renders one line shape, so it renders one policy too: quote when
// the name needs it, which is the same answer for every name that carries
// a metacharacter and differs only for the plain ones GNU's always-quoting
// half would dress up.
//
// Absent on purpose, in two groups. GNU prints the operand bare for grep,
// sed, cmp, diff, rev (util-linux), md5 (BSD) and zcat (gzip). And the
// tools that are nobody's coreutils — awk, column, file, iconv, jq, look,
// xxd — keep their own original's diagnostic, which is not this one.
export const SHELL_QUOTED_COMMANDS: ReadonlySet<string> = new Set([
  'b2sum',
  'base64',
  'cat',
  'comm',
  'csplit',
  'cut',
  'df',
  'expand',
  'fmt',
  'fold',
  'join',
  'md5sum',
  'nl',
  'od',
  'paste',
  'readlink',
  'realpath',
  'sha1sum',
  'sha224sum',
  'sha256sum',
  'sha384sum',
  'sha512sum',
  'shuf',
  'sort',
  'split',
  'strings',
  'tee',
  'tsort',
  'unexpand',
  'uniq',
  'wc',
])

function quote(name: string, style: string): string {
  const stream = openStreamSync('quote', { style })
  try {
    stream.feed(encodeText(name))
    return decodeText(stream.finish())
  } finally {
    stream.close()
  }
}

// Whether a command reports its path operands shell-quoted.
export function quotesOperands(cmdName: string): boolean {
  return SHELL_QUOTED_COMMANDS.has(cmdName)
}

/** GNU ls -b, using shellQuoteAlways's documented UTF-8 locale policy. */
export function escapeName(name: string): string {
  return quote(name, 'escape')
}

// Wrap a name so a shell would read it back as itself: GNU's
// shell-escape-always quoting style. The "name" form when the name holds a
// single quote and nothing else that would need escaping there, otherwise
// the 'name' form, where an embedded quote becomes '\'' and a run of
// control characters becomes one $'...' group. Deliberate divergence: a
// non-ASCII character is ordinary and stays as itself, which is GNU under
// a UTF-8 locale; the C locale would render every byte of it in octal,
// and mirage has no locale to switch on.
export function shellQuoteAlways(name: string): string {
  return quote(name, 'shell_always')
}

// Wrap a name only when a shell would read it back as something else:
// GNU's shell-escape quoting style, byte-identical with the python
// shell_quote. `nope.txt` stays bare and `*.txt` becomes `'*.txt'`, which
// is what makes a name carrying a metacharacter readable in a diagnostic
// without dressing up every ordinary one.
export function shellQuote(name: string): string {
  return quote(name, 'shell')
}

// Wrap text so bash reads it back as exactly one word: the quoting bash
// itself writes, always the 'text' form, with an embedded quote spelled
// '\'' and every other character, newlines included, left as itself. This
// is not shellQuoteAlways, which is GNU's diagnostic rendering and may
// answer with the "text" form or a $'...' group; bash uses this one
// wherever it builds a command line out of data (`alias` printing a
// value, `mapfile -C` handing a record to a callback), so text that is
// shell syntax stays a single argument.
export function singleQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`
}
