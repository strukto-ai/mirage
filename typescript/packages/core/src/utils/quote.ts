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

// The characters that make a name unsafe to paste back into a shell, so
// GNU wraps it. Probed byte by byte against coreutils 9.7 on
// debian:stable-slim; ':' is in the set because a diagnostic uses it as
// the separator, and ']' '%' '+' ',' '-' '.' '@' '_' are deliberately
// absent because GNU leaves them bare.
const ALWAYS_SPECIAL = new Set(' !"$&\'()*:;<=>?[\\^`|')

// '#' starts a comment and '~' starts a home-directory expansion, but
// only as the first character of a word, so GNU quotes them there alone.
const LEADING_SPECIAL = new Set('#~')

// Brace expansion needs a pair to mean anything, so GNU quotes a lone
// brace and leaves one inside a longer name bare.
const SOLO_SPECIAL = new Set(['{', '}'])

// What rules out the "name" form for a name holding a single quote.
// Narrower than the trigger set: a space and a ':' are harmless inside
// double quotes, while the four conditional characters above lose their
// position rule and always rule it out.
const DQ_BLOCKERS = new Set('!"#$&()*;<=>?[\\^`{|}~')

const ENC = new TextEncoder()

const NAMED_ESCAPES = new Map([
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
// family quote only when the name needs it (gnulib's shell_escape style),
// while head/tail/tac/fmt/split/csplit/truncate/strings quote always and
// word the line differently ("cannot open X for reading"). mirage renders
// one line shape for the whole read family, so it renders one policy too:
// quote when the name needs it, which is the same answer for every name
// that carries a metacharacter and differs only for the plain ones GNU's
// always-quoting half would dress up.
//
// Absent on purpose, in two groups. GNU prints the operand bare for grep,
// sed, cmp, diff, rev (util-linux), md5 (BSD) and zcat (gzip). And the
// tools that are nobody's coreutils — awk, column, file, iconv, jq, look,
// xxd — keep their own original's diagnostic, which is not this one.
export const SHELL_QUOTED_COMMANDS: ReadonlySet<string> = new Set([
  'base64',
  'cat',
  'comm',
  'csplit',
  'cut',
  'df',
  'expand',
  'fmt',
  'fold',
  'head',
  'join',
  'md5sum',
  'nl',
  'od',
  'paste',
  'sha1sum',
  'sha256sum',
  'sha384sum',
  'sha512sum',
  'shuf',
  'sort',
  'split',
  'strings',
  'tac',
  'tail',
  'tee',
  'truncate',
  'tsort',
  'unexpand',
  'uniq',
  'wc',
])

function needsEscape(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  if (code < 0x20 || code === 0x7f) return true
  // The C1 controls and the two line/paragraph separators are the only
  // code points above ASCII that glibc's iswprint refuses in a UTF-8
  // locale, so they are the only ones GNU escapes there (probed: NBSP, a
  // soft hyphen, ZWSP, a BOM, a private-use character and an emoji all
  // print as themselves). Deliberately not covered is the third class GNU
  // escapes, an unassigned code point: which ones those are moves with the
  // Unicode version each language happens to ship, and a python/typescript
  // split is worse than the gap.
  return (code >= 0x80 && code <= 0x9f) || code === 0x2028 || code === 0x2029
}

function escapeChar(char: string): string {
  const named = NAMED_ESCAPES.get(char)
  if (named !== undefined) return `\\${named}`
  // GNU escapes bytes, not code points, so a non-ASCII character costs one
  // octal group per UTF-8 byte (U+0085 is `\302\205`).
  return Array.from(ENC.encode(char), (byte) => `\\${byte.toString(8).padStart(3, '0')}`).join('')
}

// Whether a command reports its path operands shell-quoted.
export function quotesOperands(cmdName: string): boolean {
  return SHELL_QUOTED_COMMANDS.has(cmdName)
}

// Whether a name cannot be pasted back into a shell as written.
export function needsShellQuote(name: string): boolean {
  // An empty operand has to be quoted or it disappears from the line
  // entirely, taking the answer to "which name failed" with it.
  if (name === '' || SOLO_SPECIAL.has(name)) return true
  let index = 0
  for (const char of name) {
    if (ALWAYS_SPECIAL.has(char) || needsEscape(char)) return true
    if (index === 0 && LEADING_SPECIAL.has(char)) return true
    index += 1
  }
  return false
}

// Wrap a name so a shell would read it back as itself: GNU's
// shell_escape_always rendering. The "name" form when the name holds a
// single quote and nothing else that would need escaping there, otherwise
// the 'name' form, where an embedded quote becomes '\'' and a run of
// control characters becomes one $'...' group. Deliberate divergence: a
// non-ASCII character is ordinary and stays as itself, which is GNU under
// a UTF-8 locale; the C locale would render every byte of it in octal,
// and mirage has no locale to switch on.
export function shellQuoteAlways(name: string): string {
  if (name.includes("'")) {
    let plain = true
    for (const char of name) {
      if (DQ_BLOCKERS.has(char) || needsEscape(char)) {
        plain = false
        break
      }
    }
    if (plain) return `"${name}"`
  }
  const parts = ["'"]
  let inEscape = false
  for (const char of name) {
    if (needsEscape(char)) {
      if (!inEscape) {
        parts.push("'$'")
        inEscape = true
      }
      parts.push(escapeChar(char))
      continue
    }
    // A quote closes whichever group is open and reopens the plain one,
    // so it costs the same three characters either way; only a plain
    // character after an escape run needs a group swap.
    if (char === "'") {
      parts.push("'\\''")
      inEscape = false
      continue
    }
    if (inEscape) {
      parts.push("''")
      inEscape = false
    }
    parts.push(char)
  }
  parts.push("'")
  return parts.join('')
}

// Wrap a name only when a shell would read it back as something else:
// GNU's shell_escape rendering, byte-identical with the python
// shell_quote. `nope.txt` stays bare and `*.txt` becomes `'*.txt'`, which
// is what makes a name carrying a metacharacter readable in a diagnostic
// without dressing up every ordinary one.
export function shellQuote(name: string): string {
  if (!needsShellQuote(name)) return name
  return shellQuoteAlways(name)
}
