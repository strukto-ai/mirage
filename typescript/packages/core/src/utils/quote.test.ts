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

import { describe, expect, it } from 'vitest'
import {
  needsShellQuote,
  quotesOperands,
  SHELL_QUOTED_COMMANDS,
  shellQuote,
  shellQuoteAlways,
} from './quote.ts'

// Every printable ASCII character, classified by whether GNU coreutils 9.7
// quotes a name holding it. Probed one byte at a time on debian:stable-slim
// with `cat -- a<c>b`; the four position-dependent characters (#, ~, {, })
// are covered separately below.
const TRIGGERS = ' !"$&\'()*:;<=>?[\\^`|'
const BARE = '%+,-./0123456789@ABCXYZ]_abcxyz'

describe('shellQuote', () => {
  it('quotes a name holding any shell metacharacter', () => {
    for (const char of TRIGGERS) {
      expect(needsShellQuote(`a${char}b`), char).toBe(true)
      expect(shellQuote(`a${char}b`), char).not.toBe(`a${char}b`)
    }
  })

  it('leaves a name of ordinary characters bare', () => {
    for (const char of BARE) {
      expect(needsShellQuote(`a${char}b`), char).toBe(false)
      expect(shellQuote(`a${char}b`), char).toBe(`a${char}b`)
    }
  })

  it('treats # and ~ as special only in first position', () => {
    for (const char of ['#', '~']) {
      expect(shellQuote(`${char}nope`)).toBe(`'${char}nope'`)
      expect(shellQuote(`no${char}pe`)).toBe(`no${char}pe`)
    }
  })

  it('treats a brace as special only alone', () => {
    for (const char of ['{', '}']) {
      expect(shellQuote(char)).toBe(`'${char}'`)
      expect(shellQuote(`${char}a`)).toBe(`${char}a`)
      expect(shellQuote(`a${char}`)).toBe(`a${char}`)
    }
  })

  it('reports a plain name as typed', () => {
    expect(shellQuote('nope.txt')).toBe('nope.txt')
    expect(shellQuote('/data/nope.txt')).toBe('/data/nope.txt')
  })

  it('quotes a glob operand', () => {
    expect(shellQuote('/data/*.txt')).toBe("'/data/*.txt'")
    expect(shellQuote('a b')).toBe("'a b'")
  })

  it('switches to double quotes for a name holding a single quote', () => {
    expect(shellQuote("a'b")).toBe('"a\'b"')
    expect(shellQuote("a'b c")).toBe('"a\'b c"')
    expect(shellQuote("a'b:c")).toBe('"a\'b:c"')
  })

  it('falls back when another special rules the double-quote form out', () => {
    expect(shellQuote("a'b*c")).toBe("'a'\\''b*c'")
    expect(shellQuote('a\'b"c')).toBe("'a'\\''b\"c'")
    expect(shellQuote("a'b#c")).toBe("'a'\\''b#c'")
  })

  it('renders control characters as $ escape groups', () => {
    expect(shellQuote('a\tb')).toBe("'a'$'\\t''b'")
    expect(shellQuote('a\t\tb')).toBe("'a'$'\\t\\t''b'")
    expect(shellQuote('\ta')).toBe("''$'\\t''a'")
    expect(shellQuote('a\t')).toBe("'a'$'\\t'")
    expect(shellQuote('a\x01b')).toBe("'a'$'\\001''b'")
    expect(shellQuote('a\x7fb')).toBe("'a'$'\\177''b'")
  })

  it('reopens once for a quote right after an escape group', () => {
    // The closing quote of the $'...' group doubles as the one a '\'' needs,
    // so GNU emits `'x'$'\t'\''y'` and not a redundant `''` between them.
    expect(shellQuote("x\t'y")).toBe("'x'$'\\t'\\''y'")
  })

  it('reports an empty name as empty quotes', () => {
    // Unquoted it would vanish from the line, taking the answer to "which
    // name failed" with it, so GNU quotes it under both policies.
    expect(needsShellQuote('')).toBe(true)
    expect(shellQuote('')).toBe("''")
    expect(shellQuoteAlways('')).toBe("''")
  })

  it('treats printable non-ASCII as ordinary', () => {
    // Deliberate divergence from GNU in the C locale, which renders every
    // byte in octal; this is GNU under a UTF-8 locale, which mirage models
    // because a virtual path is a string, not a byte sequence.
    expect(shellQuote('café.txt')).toBe('café.txt')
    expect(shellQuote('中 文')).toBe("'中 文'")
    expect(shellQuote("a'b中")).toBe('"a\'b中"')
    // NBSP, a soft hyphen, ZWSP, a BOM and an emoji are all printable to
    // glibc, so none of them even forces the quotes.
    for (const char of ['\u00a0', '\u00ad', '\u200b', '\ufeff', '\u{1f600}']) {
      expect(shellQuote(`a${char}b`), char).toBe(`a${char}b`)
    }
  })

  it('escapes the UTF-8 bytes of a non-printing code point', () => {
    // The C1 controls and the two line/paragraph separators are what
    // glibc's iswprint refuses in a UTF-8 locale, and GNU escapes bytes,
    // not code points.
    const cases: [string, string][] = [
      ['\u0080', '\\302\\200'],
      ['\u0085', '\\302\\205'],
      ['\u009f', '\\302\\237'],
      ['\u2028', '\\342\\200\\250'],
      ['\u2029', '\\342\\200\\251'],
    ]
    for (const [char, octal] of cases) {
      expect(shellQuote(`a${char}b`), char).toBe(`'a'$'${octal}''b'`)
    }
  })
})

describe('shellQuoteAlways', () => {
  it('quotes even an ordinary name', () => {
    expect(shellQuoteAlways('nope.txt')).toBe("'nope.txt'")
    expect(shellQuoteAlways('a~b')).toBe("'a~b'")
    expect(shellQuoteAlways("a'b")).toBe('"a\'b"')
    expect(shellQuoteAlways('/data/*.txt')).toBe("'/data/*.txt'")
  })
})

describe('quotesOperands', () => {
  it('reads the table', () => {
    expect(quotesOperands('cat')).toBe(true)
    expect(quotesOperands('wc')).toBe(true)
    expect(quotesOperands('head')).toBe(true)
    expect(quotesOperands('sort')).toBe(true)
    expect(quotesOperands('grep')).toBe(false)
    expect(quotesOperands('sed')).toBe(false)
    expect(quotesOperands('rev')).toBe(false)
  })

  it('keeps the never-quoting commands out of the table', () => {
    // GNU prints these operands bare: grep/sed/cmp/diff have their own
    // diagnostics, rev is util-linux, md5 is BSD and zcat is gzip. The rest
    // are nobody's coreutils and keep their own original's wording.
    // prettier-ignore
    for (const name of ['grep', 'sed', 'cmp', 'diff', 'rev', 'md5', 'zcat',
                        'awk', 'column', 'file', 'iconv', 'jq', 'look', 'xxd']) {
      expect(SHELL_QUOTED_COMMANDS.has(name), name).toBe(false)
    }
  })
})
