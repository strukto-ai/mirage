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
  argmatchError,
  argmatchLine,
  argmatchValidBlock,
  invalidArgumentError,
  missingRequiredError,
  missingValueError,
  oldOptionError,
  unexpectedValueError,
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

  // Measured on GNU coreutils 9.4 under `LC_ALL=C LANG=C TZ=UTC` with a raw
  // `bytes` argv (ground truth QS.1 and QS.3a). Mirrors test_usage.py.
  it('escapes the word through gnulib quote()', () => {
    const [msg, code] = invalidArgumentError('tee', '--output-error', 'xé', ['warn'])
    expect(new TextDecoder().decode(msg)).toBe(
      "tee: invalid argument 'x\\303\\251' for '--output-error'\n" +
        "Valid arguments are:\n  - 'warn'\n" +
        "Try 'tee --help' for more information.\n",
    )
    expect(code).toBe(1)
  })

  // gnulib's argmatch matches on a prefix and `''` is a prefix of every
  // candidate, so the empty word comes back AMBIGUOUS. Measured the same way
  // at `tail --follow=`, `sort --check=`, `wc --total=`,
  // `uniq --all-repeated=`, `uniq --group=`, `ls --format=`,
  // `ls -l --time-style=` and `cp --update=`.
  it('words an empty value as ambiguous, not invalid', () => {
    const [msg, code] = invalidArgumentError('tee', '--output-error', '', ['warn'])
    expect(new TextDecoder().decode(msg).split('\n')[0]).toBe(
      "tee: ambiguous argument '' for '--output-error'",
    )
    expect(code).toBe(1)
  })
})

describe('argmatchLine and argmatchValidBlock', () => {
  it('words both kinds and quotes the slot', () => {
    expect(argmatchLine('ls', 'time style', 'x')).toBe("ls: invalid argument 'x' for 'time style'")
    expect(argmatchLine('ls', 'time style', '')).toBe("ls: ambiguous argument '' for 'time style'")
  })

  // GNU `sort --check=x` prints `  - 'quiet', 'silent'` on ONE line:
  // `argmatch_valid` starts a new row only when the VALUE changes.
  it('joins aliases of one value on one row', () => {
    expect(argmatchValidBlock([['quiet', 'silent'], ['diagnose-first']])).toBe(
      "Valid arguments are:\n  - 'quiet', 'silent'\n  - 'diagnose-first'",
    )
  })
})

describe('argmatchError', () => {
  it('carries the block and the code it was given', () => {
    const err = argmatchError('sort', '--check', 'x', [['quiet', 'silent'], ['diagnose-first']], 1)
    expect(err.message).toBe(
      "sort: invalid argument 'x' for '--check'\n" +
        "Valid arguments are:\n  - 'quiet', 'silent'\n  - 'diagnose-first'\n" +
        "Try 'sort --help' for more information.",
    )
    // sort's other usage errors are 2; gnulib's `argmatch_die` always calls
    // `usage (EXIT_FAILURE)`, so this one is 1.
    expect(err.exitCode).toBe(1)
    expect(usageExitCode('sort')).toBe(2)
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

// GNU getopt_long refuses a value on a BOOLEAN long option with its own
// message, which is not the unrecognized-option one: it names the option and
// drops the value, where the unrecognized message quotes the whole token.
// Measured on GNU grep 3.11 and coreutils 9.4 (new ground-truth section W):
// `grep --byte-offset=2`, `nl --help=2`, `cut --complement=2`, `sed --debug=2`.
// The per-tool usage block GNU prints between the message and the hint is
// omitted here, as it is for every other refusal in this module.
describe('unexpectedValueError', () => {
  it('names the option without the value', () => {
    const [msg, code] = unexpectedValueError('grep', '--byte-offset=2')
    expect(new TextDecoder().decode(msg)).toBe(
      "grep: option '--byte-offset' doesn't allow an argument\n" +
        "Try 'grep --help' for more information.\n",
    )
    expect(code).toBe(2)
  })

  // coreutils exit 1 where grep and sort exit 2.
  it.each<[string, number]>([
    ['nl', 1],
    ['cut', 1],
    ['wc', 1],
    ['sort', 2],
  ])('carries %s exit code', (name, expected) => {
    const [msg, code] = unexpectedValueError(name, '--bogus-bool=2')
    expect(
      new TextDecoder()
        .decode(msg)
        .startsWith(`${name}: option '--bogus-bool' doesn't allow an argument\n`),
    ).toBe(true)
    expect(code).toBe(expected)
  })

  // An empty value is still a value, and a second `=` is part of it.
  it.each(['--byte-offset=', '--byte-offset=2=3'])('names only the option for %s', (token) => {
    const [msg] = unexpectedValueError('grep', token)
    expect(
      new TextDecoder()
        .decode(msg)
        .startsWith("grep: option '--byte-offset' doesn't allow an argument\n"),
    ).toBe(true)
  })

  // curl, python, jq and find answer this as an unknown option, each measured:
  // `curl --silent=2` is `option --silent=2: is unknown`, `python3
  // --version=2` is `unknown option --version=2`, and `jq --tab=2` is jq's own
  // unknown-option line. Routing them through the getopt_long wording would put
  // GNU's words in a program that does not use GNU's parser.
  it('keeps the unknown wording for a program that is not getopt_long', () => {
    const dec = new TextDecoder()
    const [curl, curlCode] = unexpectedValueError('curl', '--silent=2')
    expect(dec.decode(curl).startsWith('curl: option --silent=2: is unknown\n')).toBe(true)
    expect(curlCode).toBe(2)
    const [jq] = unexpectedValueError('jq', '--tab=2')
    expect(dec.decode(jq).startsWith("jq: unrecognized option '--tab=2'\n")).toBe(true)
    const [py] = unexpectedValueError('python3', '--version=2')
    expect(dec.decode(py).startsWith('unknown option --version=2\n')).toBe(true)
    const [find] = unexpectedValueError('find', '--help=2')
    expect(dec.decode(find)).toBe("find: unknown predicate `--help=2'\n")
  })
})

// getopt prints `argv[optind]` with a plain `%s`, never quote(). Every
// coreutils clause that names a *value* runs it through gnulib's `quote()`
// (an `é` comes back as `\303\251`), but the unrecognized-option clause is
// getopt's own and carries the token's bytes as typed. Measured under
// `LC_ALL=C` with a raw `bytes` argv on coreutils 9.4: `cut --zzz=é`
// reports `'--zzz=é'` with the two UTF-8 bytes intact, and
// `wc --zzz=$'\001'` carries the raw 0x01. Same for nl, expand, shuf,
// tail, split, du, sort, uniq, ls and cp. This asymmetry is deliberate; do
// not route this clause through quote(). Mirrors test_usage.py.
describe('unknownOptionError leaves the token unescaped', () => {
  it.each([
    ['cut', '--zzz=é'],
    ['wc', '--zzz=\x01'],
  ])('keeps %s’s token as typed', (cmd, token) => {
    const [msg] = unknownOptionError(cmd, token)
    expect(td.decode(msg).startsWith(`${cmd}: unrecognized option '${token}'\n`)).toBe(true)
  })
})
