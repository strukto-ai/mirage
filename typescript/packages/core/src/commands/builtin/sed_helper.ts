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

const SIMPLE_CMDS = new Set(['d', 'D', 'p', 'P', 'h', 'H', 'g', 'G', 'x', 'N', 'q'])

type SedAddr = ['line', string] | ['last', ''] | ['regex', string]

export interface SedCommand {
  cmd: string
  addrStart?: SedAddr | null
  addrEnd?: SedAddr | null
  negate?: boolean
  pattern?: string
  replacement?: string
  exprFlags?: string
  text?: string
  label?: string
}

function parseAddress(addr: string): SedAddr | null {
  if (addr === '') return null
  if (addr.startsWith('/')) {
    const end = addr.indexOf('/', 1)
    return ['regex', addr.slice(1, end)]
  }
  if (/^\d+$/.test(addr)) return ['line', addr]
  if (addr === '$') return ['last', '']
  return null
}

function consumeAddress(rest: string): [SedAddr | null, string] {
  if (rest === '') return [null, rest]
  if (rest.startsWith('/')) {
    const end = rest.indexOf('/', 1)
    const addr: SedAddr = ['regex', rest.slice(1, end)]
    return [addr, rest.slice(end + 1)]
  }
  const first = rest[0]
  if (first !== undefined && (/\d/.test(first) || first === '$')) {
    let num = ''
    while (rest.length > 0) {
      const c: string | undefined = rest[0]
      if (c === undefined || !(/\d/.test(c) || c === '$')) break
      num += c
      rest = rest.slice(1)
    }
    return [parseAddress(num), rest]
  }
  return [null, rest]
}

function readLabelOrBranch(rest: string): [string, string] {
  let label = ''
  while (rest.length > 0) {
    const c: string | undefined = rest[0]
    if (c === undefined || c === ';' || c === '}') break
    label += c
    rest = rest.slice(1)
  }
  return [label.trim(), rest]
}

export function parseOneCommand(rest: string): [SedCommand, string] {
  let addrStart: SedAddr | null = null
  let addrEnd: SedAddr | null = null
  ;[addrStart, rest] = consumeAddress(rest)
  if (addrStart !== null && rest.startsWith(',')) {
    ;[addrEnd, rest] = consumeAddress(rest.slice(1))
  }
  // Optional address negation: `addr!command` (whitespace allowed around `!`)
  // applies the command to every line the address does NOT select.
  let negate = false
  let probe = rest
  while (probe.startsWith(' ')) probe = probe.slice(1)
  if (probe.startsWith('!')) {
    negate = true
    rest = probe.slice(1)
    while (rest.startsWith(' ')) rest = rest.slice(1)
  }
  if (rest === '') throw new Error('sed: missing command')
  const ch = rest[0]
  if (ch === '{') return [{ cmd: '{', addrStart, addrEnd, negate }, rest.slice(1)]
  if (ch === '}') return [{ cmd: '}' }, rest.slice(1)]
  if (ch === ':') {
    const [label, after] = readLabelOrBranch(rest.slice(1))
    return [{ cmd: ':', label }, after]
  }
  if (ch === 'b' || ch === 't') {
    const [label, after] = readLabelOrBranch(rest.slice(1))
    return [{ cmd: ch, label, addrStart, addrEnd, negate }, after]
  }
  if (ch === 's') {
    const delim = rest[1]
    if (delim === undefined) throw new Error('sed: missing delimiter')
    // Read pattern and replacement up to the next delimiter, then consume only
    // the trailing flag characters. Anything after is a separate command — a
    // plain split() would wrongly fold it into the flags (e.g. `s/a/b/;d`).
    let i = 2
    // A backslash escapes the next char (incl. the delimiter: `s/a\/b/c/`).
    const field = (): string => {
      let value = ''
      while (i < rest.length && rest[i] !== delim) {
        const c = rest[i]
        if (c === '\\' && i + 1 < rest.length) {
          value += c + (rest[i + 1] ?? '')
          i += 2
          continue
        }
        value += c ?? ''
        i += 1
      }
      i += 1
      return value
    }
    const pattern = field()
    const replacement = field()
    let exprFlags = ''
    while (i < rest.length) {
      const fc = rest[i]
      if (fc === undefined || !/[0-9gpiImMe]/.test(fc)) break
      exprFlags += fc
      i += 1
    }
    const cm = /[0-9]+/.exec(exprFlags)
    if (cm && Number.parseInt(cm[0], 10) === 0) {
      throw new Error("sed: number option to `s' command may not be zero")
    }
    return [
      { cmd: 's', pattern, replacement, exprFlags, addrStart, addrEnd, negate },
      rest.slice(i),
    ]
  }
  if (ch === 'y') {
    // y/src/dst/ — transliterate src[i] -> dst[i]; the two sets must match in
    // length. Read both fields up to the delimiter (no trailing flags).
    const delim = rest[1]
    if (delim === undefined) throw new Error('sed: missing delimiter')
    let i = 2
    const field = (): string => {
      const start = i
      while (i < rest.length && rest[i] !== delim) i += 1
      const value = rest.slice(start, i)
      i += 1
      return value
    }
    const pattern = field()
    const replacement = field()
    if (pattern.length !== replacement.length) {
      throw new Error('sed: strings for `y` command are different lengths')
    }
    return [{ cmd: 'y', pattern, replacement, addrStart, addrEnd, negate }, rest.slice(i)]
  }
  if (ch !== undefined && SIMPLE_CMDS.has(ch)) {
    return [{ cmd: ch, addrStart, addrEnd, negate }, rest.slice(1)]
  }
  if (ch === 'a' || ch === 'i' || ch === 'c') {
    // Text forms: `a\` <newline> text (the classic multi-line form, where the
    // backslash-newline is a continuation and not part of the text), `a\text`,
    // and the one-line `a text`. Strip that leading prefix so the text itself
    // does not start with a stray newline.
    let text = rest.slice(1)
    if (text.startsWith('\\')) {
      text = text.slice(1)
      if (text.startsWith('\n')) text = text.slice(1)
    } else if (text.startsWith(' ')) {
      text = text.slice(1)
    }
    let end = text.length
    for (let j = 0; j < text.length; j++) {
      if (text[j] === ';') {
        end = j
        break
      }
    }
    return [{ cmd: ch, text: text.slice(0, end), addrStart, addrEnd, negate }, text.slice(end)]
  }
  throw new Error(`sed: unsupported command: ${String(ch)}`)
}

export function parseProgram(expr: string): SedCommand[] {
  const commands: SedCommand[] = []
  let rest = expr.trim()
  while (rest !== '') {
    const first = rest[0]
    if (first === ';' || first === '\n') {
      rest = rest.slice(1).replace(/^\s+/, '')
      continue
    }
    if (first === ' ') {
      rest = rest.slice(1)
      continue
    }
    const [cmd, after] = parseOneCommand(rest)
    commands.push(cmd)
    rest = after.replace(/^\s+/, '')
  }
  return commands
}

// Translate a POSIX Basic Regular Expression to the Extended syntax used by
// the host regex engine (JS RegExp / Python re). GNU sed scripts are BRE by
// default and ERE only under -E/-r. In BRE the bare metacharacters `( ) { } +
// ? |` are literal and their backslashed forms are special; ERE is the
// reverse. `^`/`$` are anchors only at the start/end (literal elsewhere) and a
// leading `*` is literal. See issue: sed BRE/ERE support.
export function breToEre(pat: string): string {
  let out = ''
  let i = 0
  const n = pat.length
  // True when the next character begins the regex or a subexpression (after
  // `\(` or `\|`), where `*` is literal and `^` is an anchor.
  let atStart = true
  while (i < n) {
    const ch = pat[i]
    if (ch === undefined) break
    if (ch === '[') {
      // Bracket expression: copy verbatim through the closing `]`.
      out += '['
      let j = i + 1
      if (pat[j] === '^') {
        out += '^'
        j += 1
      }
      if (pat[j] === ']') {
        out += ']'
        j += 1
      }
      while (j < n && pat[j] !== ']') {
        out += pat[j] ?? ''
        j += 1
      }
      if (j < n) {
        out += ']'
        j += 1
      }
      i = j
      atStart = false
      continue
    }
    if (ch === '\\') {
      const nx = pat[i + 1]
      if (nx === undefined) {
        out += '\\'
        i += 1
        continue
      }
      // Backslashed (){}+?| are the *special* forms in BRE -> emit bare (ERE).
      if (
        nx === '(' ||
        nx === ')' ||
        nx === '{' ||
        nx === '}' ||
        nx === '+' ||
        nx === '?' ||
        nx === '|'
      ) {
        out += nx
        atStart = nx === '(' || nx === '|'
        i += 2
        continue
      }
      // Any other escape passes through unchanged (\. \* \[ \\ \1.. \n \t ...).
      out += '\\' + nx
      atStart = false
      i += 2
      continue
    }
    // Bare (){}+?| are literal in BRE -> escape for ERE.
    if (
      ch === '(' ||
      ch === ')' ||
      ch === '{' ||
      ch === '}' ||
      ch === '+' ||
      ch === '?' ||
      ch === '|'
    ) {
      out += '\\' + ch
      atStart = false
      i += 1
      continue
    }
    if (ch === '*') {
      out += atStart ? '\\*' : '*'
      atStart = false
      i += 1
      continue
    }
    if (ch === '^') {
      // Anchor only at the start of the regex/subexpression; literal elsewhere.
      // A leading `^` keeps the start context so a following `*` stays literal.
      out += atStart ? '^' : '\\^'
      i += 1
      continue
    }
    if (ch === '$') {
      // Anchor only at the end (or before `\)` / `\|`); literal elsewhere.
      const isEnd =
        i === n - 1 || (pat[i + 1] === '\\' && (pat[i + 2] === ')' || pat[i + 2] === '|'))
      out += isEnd ? '$' : '\\$'
      atStart = false
      i += 1
      continue
    }
    out += ch
    atStart = false
    i += 1
  }
  return out
}

function compilePattern(pat: string, flags: string, extended: boolean): RegExp {
  return new RegExp(extended ? pat : breToEre(pat), flags)
}

function addrMatches(
  addr: SedAddr,
  line: string,
  lineno: number,
  total: number,
  extended: boolean,
): boolean {
  const [kind, val] = addr
  if (kind === 'line') return lineno === Number.parseInt(val, 10)
  if (kind === 'last') return lineno === total
  // kind === 'regex' — the pattern space has no trailing newline, so anchors
  // (^/$) match line content directly.
  return compilePattern(val, '', extended).test(line)
}

export function translateReplacement(repl: string): string {
  let out = ''
  for (let i = 0; i < repl.length; i++) {
    const ch = repl[i]
    if (ch === '$') {
      out += '$$'
      continue
    }
    if (ch === '&') {
      // Unescaped `&` is the whole match (JS `$&`); `\&` (below) is literal.
      out += '$&'
      continue
    }
    if (ch === '\\' && i + 1 < repl.length) {
      const next = repl[i + 1]
      if (next !== undefined && /[0-9]/.test(next)) {
        out += '$' + next
        i += 1
        continue
      }
      if (next === '\\') {
        out += '\\'
        i += 1
        continue
      }
      if (next === '&') {
        out += '&'
        i += 1
        continue
      }
      if (next === 'n') {
        out += '\n'
        i += 1
        continue
      }
      if (next === 't') {
        out += '\t'
        i += 1
        continue
      }
      out += next ?? ''
      i += 1
      continue
    }
    out += ch ?? ''
  }
  return out
}

function regexReplace(
  text: string,
  pat: string,
  repl: string,
  ignoreCase: boolean,
  global: boolean,
  count = 1,
  extended = false,
): string {
  // The pattern space excludes the line-separator newline (GNU semantics), so
  // `^`/`$` anchor to its content directly — no stripping needed here.
  // `count` is the 1-based occurrence the substitution starts at (GNU sed's
  // numeric `s///N` flag, default 1). Without `g` only that single occurrence
  // is replaced; with `g` that occurrence and every later one are. Iterate all
  // matches and decide per match so `N` and `Ng` both work.
  const baseFlags = ignoreCase ? 'i' : ''
  const erePat = extended ? pat : breToEre(pat)
  const scan = new RegExp(erePat, baseFlags + 'g')
  const single = new RegExp(erePat, baseFlags)
  const jsRepl = translateReplacement(repl)
  let n = 0
  return text.replace(scan, (m: string) => {
    n += 1
    const hit = global ? n >= count : n === count
    return hit ? m.replace(single, jsRepl) : m
  })
}

// Split into line contents WITHOUT trailing newlines (the sed pattern space
// excludes the separator). `finalNewline` records whether the input's last
// line ended with a newline, so output can preserve a missing final newline.
function splitContentLines(text: string): { lines: string[]; finalNewline: boolean } {
  if (text === '') return { lines: [], finalNewline: false }
  const finalNewline = text.endsWith('\n')
  const body = finalNewline ? text.slice(0, -1) : text
  return { lines: body.split('\n'), finalNewline }
}

export function executeProgram(
  text: string,
  commands: SedCommand[],
  suppress = false,
  extended = false,
): string {
  const { lines, finalNewline } = splitContentLines(text)
  const total = lines.length
  let hold = ''
  const output: string[] = []
  const labelMap = new Map<string, number>()
  for (let idx = 0; idx < commands.length; idx++) {
    const c = commands[idx]
    if (c?.cmd === ':' && c.label !== undefined) labelMap.set(c.label, idx)
  }
  const rangeActive = new Map<number, boolean>()
  // Trailing newline for a pattern space whose last consumed line is `ln`
  // (1-based): every line gets one except a last line that had none on input.
  const tailNL = (ln: number): string => (ln < total || finalNewline ? '\n' : '')

  let i = 0
  while (i < total) {
    let pattern = lines[i] ?? ''
    i += 1
    let lineno = i
    const deferred: string[] = []
    let pc = 0
    let deleteFlag = false
    let substituted = false

    while (pc < commands.length) {
      const cmd = commands[pc]
      if (cmd === undefined) {
        pc += 1
        continue
      }
      const c = cmd.cmd
      if (c === ':' || c === '}') {
        pc += 1
        continue
      }

      let matched = true
      if (cmd.addrStart !== null && cmd.addrStart !== undefined) {
        if (cmd.addrEnd !== null && cmd.addrEnd !== undefined) {
          const rid = pc
          if (rangeActive.get(rid) !== true) {
            if (addrMatches(cmd.addrStart, pattern, lineno, total, extended))
              rangeActive.set(rid, true)
            else matched = false
          }
          if (rangeActive.get(rid) === true) {
            if (addrMatches(cmd.addrEnd, pattern, lineno, total, extended))
              rangeActive.set(rid, false)
          }
        } else {
          if (!addrMatches(cmd.addrStart, pattern, lineno, total, extended)) matched = false
        }
      }
      // `addr!cmd` inverts the selection (range state above is tracked normally).
      if (cmd.negate === true) matched = !matched

      if (c === '{') {
        if (!matched) {
          let depth = 1
          pc += 1
          while (pc < commands.length && depth > 0) {
            const next = commands[pc]
            if (next?.cmd === '{') depth += 1
            else if (next?.cmd === '}') depth -= 1
            pc += 1
          }
          continue
        }
        pc += 1
        continue
      }

      if (!matched) {
        pc += 1
        continue
      }

      if (c === 's') {
        const pat = cmd.pattern ?? ''
        const repl = cmd.replacement ?? ''
        const ef = cmd.exprFlags ?? ''
        const countMatch = /[0-9]+/.exec(ef)
        const count = countMatch ? Number.parseInt(countMatch[0], 10) : 1
        const newPattern = regexReplace(
          pattern,
          pat,
          repl,
          ef.includes('i'),
          ef.includes('g'),
          count,
          extended,
        )
        const changed = newPattern !== pattern
        if (changed) substituted = true
        pattern = newPattern
        // `s///p` prints the pattern space when a substitution was made.
        if (changed && ef.includes('p')) output.push(pattern + tailNL(lineno))
      } else if (c === 'd') {
        deleteFlag = true
        break
      } else if (c === 'D') {
        const nl = pattern.indexOf('\n')
        if (nl >= 0) {
          pattern = pattern.slice(nl + 1)
          pc = 0
          continue
        }
        deleteFlag = true
        break
      } else if (c === 'p') {
        output.push(pattern + tailNL(lineno))
      } else if (c === 'P') {
        const nl = pattern.indexOf('\n')
        output.push(nl >= 0 ? pattern.slice(0, nl + 1) : pattern + tailNL(lineno))
      } else if (c === 'N') {
        if (i < total) {
          pattern += '\n' + (lines[i] ?? '')
          i += 1
          lineno = i
        } else {
          break
        }
      } else if (c === 'h') {
        hold = pattern
      } else if (c === 'H') {
        // GNU appends newline + pattern unconditionally (empty hold -> leading
        // newline), so `H` on the first line yields "\n<pattern>".
        hold = hold + '\n' + pattern
      } else if (c === 'g') {
        pattern = hold
      } else if (c === 'G') {
        // GNU appends newline + hold unconditionally (empty hold -> blank line).
        pattern = pattern + '\n' + hold
      } else if (c === 'x') {
        const tmp = pattern
        pattern = hold
        hold = tmp
      } else if (c === 'a') {
        deferred.push((cmd.text ?? '') + '\n')
      } else if (c === 'i') {
        output.push((cmd.text ?? '') + '\n')
      } else if (c === 'y') {
        // Transliterate each char of pattern[i] -> replacement[i].
        const from = cmd.pattern ?? ''
        const to = cmd.replacement ?? ''
        let outY = ''
        for (const chr of pattern) {
          const idx = from.indexOf(chr)
          outY += idx >= 0 ? (to[idx] ?? chr) : chr
        }
        pattern = outY
      } else if (c === 'c') {
        // Change: delete the pattern space and emit the text. For a single
        // address (or none) emit on each match; for a range emit once, when
        // the range closes (or at EOF if it never does), matching GNU sed.
        deleteFlag = true
        const isRange = cmd.addrEnd !== null && cmd.addrEnd !== undefined
        const rangeOpen = rangeActive.get(pc) === true
        if (!isRange || !rangeOpen || lineno === total) {
          output.push((cmd.text ?? '') + '\n')
        }
        break
      } else if (c === 'q') {
        output.push(pattern + tailNL(lineno))
        return output.join('')
      } else if (c === 'b') {
        const label = cmd.label ?? ''
        const target = labelMap.get(label)
        if (label !== '' && target !== undefined) {
          pc = target
          continue
        }
        break
      } else if (c === 't') {
        if (substituted) {
          substituted = false
          const label = cmd.label ?? ''
          const target = labelMap.get(label)
          if (label !== '' && target !== undefined) {
            pc = target
            continue
          }
          break
        }
      }

      pc += 1
    }

    if (!deleteFlag) {
      if (!suppress) output.push(pattern + tailNL(lineno))
      for (const d of deferred) output.push(d)
    }
  }
  return output.join('')
}
