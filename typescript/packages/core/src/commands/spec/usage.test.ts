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
  ambiguousOptionError,
  extraOperandError,
  invalidFloatError,
  invalidIntError,
  invalidArgumentError,
  missingRequiredError,
  missingValueError,
  oldOptionError,
  unknownOptionError,
  readFailExitCode,
  readFailExitCodeFromLine,
  usageExitCode,
} from './usage.ts'

const td = new TextDecoder()

describe('usageExitCode', () => {
  it('matches GNU per-tool codes', () => {
    expect(usageExitCode('cat')).toBe(1)
    expect(usageExitCode('grep')).toBe(2)
    expect(usageExitCode('ls')).toBe(2)
    expect(usageExitCode('sort')).toBe(2)
    expect(usageExitCode('tar')).toBe(64)
  })
})

describe('unknownOptionError', () => {
  it('long options report the full token', () => {
    const [msg, code] = unknownOptionError('cat', '--bogus=x')
    expect(td.decode(msg)).toBe(
      "cat: unrecognized option '--bogus=x'\nTry 'cat --help' for more information.\n",
    )
    expect(code).toBe(1)
  })

  it('short options report the char', () => {
    const [msg, code] = unknownOptionError('grep', 'Y')
    expect(td.decode(msg)).toBe(
      "grep: invalid option -- 'Y'\nTry 'grep --help' for more information.\n",
    )
    expect(code).toBe(2)
  })

  it('find uses predicate wording', () => {
    const [msg, code] = unknownOptionError('find', '--bogus')
    expect(td.decode(msg)).toBe("find: unknown predicate `--bogus'\n")
    expect(code).toBe(1)
  })
})

describe('missingValueError', () => {
  it('short and long shapes', () => {
    const [shortMsg, shortCode] = missingValueError('grep', 'm')
    expect(td.decode(shortMsg)).toContain("grep: option requires an argument -- 'm'\n")
    expect(shortCode).toBe(2)
    const [longMsg, longCode] = missingValueError('du', '--max-depth')
    expect(td.decode(longMsg)).toContain("du: option '--max-depth' requires an argument\n")
    expect(longCode).toBe(1)
  })
})

describe('extraOperandError', () => {
  it('uses GNU wording and per-command exit codes', () => {
    const err = extraOperandError('uniq', 'c.txt')
    expect(err.message).toBe("uniq: extra operand 'c.txt'\nTry 'uniq --help' for more information.")
    expect(err.exitCode).toBe(1)
  })

  it('prefixes the hint for diff and exits 2', () => {
    const err = extraOperandError('diff', 'c.txt')
    expect(err.message).toBe(
      "diff: extra operand 'c.txt'\ndiff: Try 'diff --help' for more information.",
    )
    expect(err.exitCode).toBe(2)
  })

  it('says too many templates for mktemp', () => {
    const err = extraOperandError('mktemp', 't2')
    expect(err.message.startsWith('mktemp: too many templates\n')).toBe(true)
    expect(err.exitCode).toBe(1)
  })
})

describe('invalidArgumentError', () => {
  it('matches the GNU ARGMATCH shape and tee exit 1', () => {
    const [msg, code] = invalidArgumentError('tee', '--output-error', 'bogus', [
      'warn',
      'warn-nopipe',
      'exit',
      'exit-nopipe',
    ])
    expect(new TextDecoder().decode(msg)).toBe(
      "tee: invalid argument 'bogus' for '--output-error'\n" +
        'Valid arguments are:\n' +
        "  - 'warn'\n  - 'warn-nopipe'\n  - 'exit'\n  - 'exit-nopipe'\n" +
        "Try 'tee --help' for more information.\n",
    )
    expect(code).toBe(1)
  })
})

describe('missingRequiredError', () => {
  it('names the canonical spelling', () => {
    const [msg, code] = missingRequiredError('mycmd', '--out')
    expect(new TextDecoder().decode(msg)).toBe(
      "mycmd: option '--out' is required\nTry 'mycmd --help' for more information.\n",
    )
    expect(code).toBe(1)
  })
})

describe('ambiguousOptionError', () => {
  it('matches the GNU shape', () => {
    const [msg, code] = ambiguousOptionError('grep', '--c', ['--context', '--color', '--count'])
    expect(new TextDecoder().decode(msg)).toBe(
      "grep: option '--c' is ambiguous; possibilities: '--context' '--color' '--count'\n" +
        "Try 'grep --help' for more information.\n",
    )
    expect(code).toBe(2)
  })
})

describe('invalidIntError', () => {
  it('mirrors argparse wording', () => {
    const [msg, code] = invalidIntError('mycli', '--port', 'abc')
    expect(new TextDecoder().decode(msg)).toBe(
      "mycli: invalid int value: 'abc' for '--port'\n" +
        "Try 'mycli --help' for more information.\n",
    )
    expect(code).toBe(1)
  })
})

describe('invalidFloatError', () => {
  it('mirrors argparse wording', () => {
    const [msg, code] = invalidFloatError('mycli', '--ratio', '5x')
    expect(new TextDecoder().decode(msg)).toBe(
      "mycli: invalid float value: '5x' for '--ratio'\n" +
        "Try 'mycli --help' for more information.\n",
    )
    expect(code).toBe(1)
  })
})

describe('oldOptionError', () => {
  it("matches GNU tar's wording", () => {
    const [msg, code] = oldOptionError('tar', 'f')
    expect(td.decode(msg)).toBe(
      "tar: Old option 'f' requires an argument.\n" + "Try 'tar --help' for more information.\n",
    )
    // tar's own fatal error, not argp's 64.
    expect(code).toBe(2)
  })
})

describe('readFailExitCode', () => {
  const fsErr = (code: string, msg = '/x'): Error => Object.assign(new Error(msg), { code })

  it('reads the code off the command, not the errno', () => {
    expect(readFailExitCode('cat', fsErr('ENOENT'))).toBe(1)
    expect(readFailExitCode('sort', fsErr('ENOENT'))).toBe(2)
    expect(readFailExitCode('sort', fsErr('EISDIR'))).toBe(2)
    expect(readFailExitCode('unzip', fsErr('ENOENT'))).toBe(9)
  })

  it('splits by errno for the four commands that do', () => {
    // sed opens the directory and fails on the read (4) where a missing
    // file fails at open (2); the gzip family calls a directory a warning
    // (2) and a missing file an error (1); zgrep inverts that.
    expect(readFailExitCode('sed', fsErr('EISDIR'))).toBe(4)
    expect(readFailExitCode('sed', fsErr('ENOENT'))).toBe(2)
    expect(readFailExitCode('zcat', fsErr('EISDIR'))).toBe(2)
    expect(readFailExitCode('zcat', fsErr('ENOENT'))).toBe(1)
    expect(readFailExitCode('zgrep', fsErr('EISDIR'))).toBe(1)
    expect(readFailExitCode('zgrep', fsErr('ENOENT'))).toBe(2)
  })

  it('ignores anything that is not a failed read', () => {
    // The executor's chokepoints catch every error a command can throw,
    // so a table keyed by command has to be gated on the narrow errno
    // set. A bad script is not a filesystem error at all, and EACCES is
    // as often a write refusal as a read one: `sed -i` on a backend with
    // no write op is refused with EACCES and must stay 1, which is what
    // integ's lancedb_sed_i_readonly and notion_sed_i_readonly pin.
    expect(readFailExitCode('sed', fsErr('EACCES', '-i not supported'))).toBe(1)
    expect(readFailExitCode('sed', new Error('bad script'))).toBe(1)
    expect(readFailExitCode('sort', fsErr('EACCES'))).toBe(1)
    expect(readFailExitCode('sort', new Error('transport'))).toBe(1)
  })
})

describe('readFailExitCodeFromLine', () => {
  it('reads the terminal errno, not one spelled inside the path', () => {
    // The cross-mount stream path only has the rendered line, and the
    // errno is its LAST field. A path is free to spell a strerror itself,
    // and scanning the whole line read this directory as ENOENT.
    const line = 'sed: /ram/No such file or directory: Is a directory\n'
    expect(readFailExitCodeFromLine('sed', line)).toBe(4)
    expect(readFailExitCodeFromLine('cat', line)).toBe(1)
    expect(
      readFailExitCodeFromLine('sed', 'sed: /ram/Is a directory: No such file or directory\n'),
    ).toBe(2)
  })

  it('takes the most severe of a multi-line blob', () => {
    // One fetch renders several lines when the operand was a glob the
    // owning mount expanded, and sed's rule is the most severe.
    const blob = 'sed: /ram/nope: No such file or directory\nsed: /ram/dir: Is a directory\n'
    expect(readFailExitCodeFromLine('sed', blob)).toBe(4)
    expect(readFailExitCodeFromLine('sort', blob)).toBe(2)
  })

  it('keeps the catch-all for anything that is not a failed read', () => {
    expect(readFailExitCodeFromLine('sed', 'sed: -e expression #1: unknown\n')).toBe(1)
    expect(readFailExitCodeFromLine('sed', '')).toBe(1)
    expect(readFailExitCodeFromLine('sed', 'sed: /ram/Is a directory\n')).toBe(1)
  })
})

describe('curl wording', () => {
  const dec = new TextDecoder()
  const hint = "curl: try 'curl --help' or 'curl --manual' for more information\n"

  it('exits 2 on a usage error', () => {
    expect(usageExitCode('curl')).toBe(2)
  })

  it('reports an unknown option in curl words, a cluster letter dashed', () => {
    // Pinned on curl 8.14.1 (debian:stable-slim).
    const [long, code] = unknownOptionError('curl', '--bogus')
    expect(dec.decode(long)).toBe(`curl: option --bogus: is unknown\n${hint}`)
    expect(code).toBe(2)
    const [short] = unknownOptionError('curl', 'Y')
    expect(dec.decode(short)).toBe(`curl: option -Y: is unknown\n${hint}`)
  })

  it('reports a missing parameter in curl words', () => {
    const [short, code] = missingValueError('curl', 'm')
    expect(dec.decode(short)).toBe(`curl: option -m: requires parameter\n${hint}`)
    expect(code).toBe(2)
    const [long] = missingValueError('curl', '--max-time')
    expect(dec.decode(long)).toBe(`curl: option --max-time: requires parameter\n${hint}`)
  })

  it('reports a bad number in curl words', () => {
    const [line, code] = invalidFloatError('curl', '--max-time', 'abc')
    expect(dec.decode(line)).toBe(
      `curl: option --max-time: expected a proper numerical parameter\n${hint}`,
    )
    expect(code).toBe(2)
  })
})
