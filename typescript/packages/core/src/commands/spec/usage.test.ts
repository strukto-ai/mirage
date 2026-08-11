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
