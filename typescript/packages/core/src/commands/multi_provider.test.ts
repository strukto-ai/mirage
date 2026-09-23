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
import { command, hasInjectedVersion, RegisteredCommand, standardRequest } from './config.ts'
import { BUILTIN_SPECS, registeredSpec } from './spec/builtins.ts'
import { CommandSpec, Operand, Option } from './spec/types.ts'
import { IOResult } from '../io/types.ts'

const noopFn = (): Promise<[Uint8Array, IOResult]> =>
  Promise.resolve([new Uint8Array(), new IOResult()])

function specFor(name: string, spec = new CommandSpec()): CommandSpec | null {
  return command({ name, vfs: 'disk', spec, fn: noopFn })[0]?.spec ?? null
}

function decode(out: Uint8Array | null): string | null {
  return out === null ? null : new TextDecoder().decode(out)
}

// The one enriched copy the registry parses for a builtin, which is what a
// line meets at parse time; a hand-built lookalike is not that spec.
function builtinSpec(name: string): CommandSpec {
  const spec = BUILTIN_SPECS[name]
  if (spec === undefined) throw new Error(`no builtin spec for ${name}`)
  return registeredSpec(name, spec)
}

describe('command() registers multiple mounts', () => {
  it('returns one RegisteredCommand per VFS when passed an array', () => {
    const cmds = command({
      name: 'cat',
      vfs: ['gdocs', 'gdrive'],
      spec: new CommandSpec(),
      fn: noopFn,
    })
    expect(cmds).toHaveLength(2)
    const mounts = cmds.map((c) => c.vfs)
    expect(mounts).toContain('gdocs')
    expect(mounts).toContain('gdrive')
    for (const c of cmds) {
      expect(c).toBeInstanceOf(RegisteredCommand)
      expect(c.name).toBe('cat')
    }
  })

  it('single-VFS string still produces one RegisteredCommand', () => {
    const cmds = command({
      name: 'ls',
      vfs: 'disk',
      spec: new CommandSpec(),
      fn: noopFn,
    })
    expect(cmds).toHaveLength(1)
    const first = cmds[0]
    expect(first).toBeDefined()
    expect(first?.vfs).toBe('disk')
  })

  it('null VFS produces a general-registered command', () => {
    const cmds = command({
      name: 'echo',
      vfs: null,
      spec: new CommandSpec(),
      fn: noopFn,
    })
    expect(cmds).toHaveLength(1)
    expect(cmds[0]?.vfs).toBeNull()
  })

  it('auto-injects --help into spec.options', () => {
    const cmds = command({
      name: 'foo',
      vfs: 'disk',
      spec: new CommandSpec(),
      fn: noopFn,
    })
    const helpOpt = cmds[0]?.spec.options.find((o) => o.long === '--help')
    expect(helpOpt).toBeDefined()
  })

  it('--help short-circuits the handler and returns rendered help', async () => {
    let handlerCalled = false
    const cmds = command({
      name: 'bar',
      vfs: 'disk',
      spec: new CommandSpec({ description: 'do bar' }),
      fn: () => {
        handlerCalled = true
        return Promise.resolve([new Uint8Array(), new IOResult()])
      },
    })
    const opts = {
      stdin: null,
      flags: { help: true },
      filetypeFns: null,
      cwd: '/',
      vfs: {} as never,
    }
    const result = await cmds[0]?.fn({} as never, [], [], opts)
    expect(handlerCalled).toBe(false)
    const stdout = result?.[0]
    expect(stdout).toBeDefined()
    const text = new TextDecoder().decode(stdout as Uint8Array)
    expect(text).toContain('bar: do bar')
    expect(text).toContain('--help')
  })

  it('auto-injects --version into spec.options', () => {
    const cmds = command({
      name: 'foo',
      vfs: 'disk',
      spec: new CommandSpec(),
      fn: noopFn,
    })
    const versionOpt = cmds[0]?.spec.options.find((o) => o.long === '--version')
    expect(versionOpt).toBeDefined()
  })

  it('--version short-circuits the handler and returns package version', async () => {
    let handlerCalled = false
    const cmds = command({
      name: 'tsort',
      vfs: 'disk',
      spec: new CommandSpec(),
      fn: () => {
        handlerCalled = true
        return Promise.resolve([new Uint8Array(), new IOResult()])
      },
    })
    const opts = {
      stdin: null,
      flags: { version: true },
      filetypeFns: null,
      cwd: '/',
      vfs: {} as never,
    }
    const result = await cmds[0]?.fn({} as never, [], [], opts)
    expect(handlerCalled).toBe(false)
    const stdout = result?.[0]
    expect(stdout).toBeDefined()
    const text = new TextDecoder().decode(stdout as Uint8Array)
    expect(text).toMatch(/^tsort \(Mirage\) \d+\.\d+\.\d+(?:-[\w.]+)?\n$/)
  })
})

describe('standardRequest', () => {
  it('matches the injected option', () => {
    const out = standardRequest('tsort', specFor('tsort'), ['--version'])
    expect(decode(out)).toMatch(/^tsort \(Mirage\) \d+\.\d+\.\d+(?:-[\w.]+)?\n$/)
  })

  it('is null without the flag', () => {
    expect(standardRequest('tsort', specFor('tsort'), ['/data/a.txt'])).toBeNull()
  })

  it('is null after the end-of-options marker', () => {
    expect(standardRequest('grep', specFor('grep'), ['--', '--version'])).toBeNull()
  })

  it('is null for an unregistered command', () => {
    expect(standardRequest('nope', null, ['--version'])).toBeNull()
  })

  it('is null when the command declares its own --version', () => {
    const own = new CommandSpec({ options: [new Option({ long: '--version' })] })
    expect(standardRequest('custom', specFor('custom', own), ['--version'])).toBeNull()
  })

  // This runs ahead of the parser, and the parser expands an abbreviation, so
  // the two have to agree on what named the option: a line that spans mounts
  // never reaches the enriched spec (it parses against the shared BUILTIN_SPECS
  // entry, which carries no --version), so an exact-match-only check answered
  // `cat --vers /ram/a` and refused `cat --vers /ram/a /disk/b`.
  it('matches an unambiguous abbreviation', () => {
    for (const word of ['--vers', '--versio', '--v']) {
      const out = standardRequest('tsort', specFor('tsort'), [word, '/data/a.txt'])
      expect(decode(out)).toMatch(/^tsort \(Mirage\)/)
    }
  })

  // A value is the parser's to refuse, in getopt_long's own words
  // (`option '--version' doesn't allow an argument`), and an abbreviation
  // naming two options is not this option at all.
  it('is null for an abbreviation carrying a value or naming two options', () => {
    expect(standardRequest('tsort', specFor('tsort'), ['--versio=x'])).toBeNull()
    expect(standardRequest('tsort', specFor('tsort'), ['--version=x'])).toBeNull()
    const two = new CommandSpec({ options: [new Option({ long: '--verbose' })] })
    expect(standardRequest('custom', specFor('custom', two), ['--ver'])).toBeNull()
  })

  // expr reads a long option only when it is the whole line, and only for
  // expr's own grammar: a registered command that borrowed the name answers
  // wherever the word sits, like every other command.
  it('holds the sole-argument window for the builtin alone', () => {
    expect(standardRequest('expr', builtinSpec('expr'), ['--versio'])).not.toBeNull()
    expect(standardRequest('expr', builtinSpec('expr'), ['--version', 'x'])).toBeNull()
    const borrowed = specFor('expr', new CommandSpec({ rest: new Operand({ type: 'str' }) }))
    expect(standardRequest('expr', borrowed, ['--version', 'x'])).not.toBeNull()
  })

  // `--version` is an option like any other, so an option error the scan meets
  // FIRST is what GNU reports: measured on coreutils 9.7, `cat --bogus --vers`
  // is `cat: unrecognized option '--bogus'` (exit 1) and `sort --bogus
  // --version` is sort's own (exit 2).
  it('lets a refusal the scan meets first outrank the version', () => {
    for (const name of ['cat', 'sort', 'tee']) {
      expect(standardRequest(name, builtinSpec(name), ['--bogus', '--vers'])).toBeNull()
      expect(standardRequest(name, builtinSpec(name), ['--bogus', '--version'])).toBeNull()
    }
  })

  // The mirror: coreutils answers INSIDE the getopt loop, calling `version_etc`
  // and exiting there, so a word the scan never reaches cannot outrank it
  // (`cat --version --bogus` prints the version and exits 0 on 9.7).
  it('does not let a refusal the scan never reaches outrank it', () => {
    expect(standardRequest('cat', builtinSpec('cat'), ['--version', '--bogus'])).not.toBeNull()
    expect(standardRequest('cat', builtinSpec('cat'), ['--vers', '--bogus'])).not.toBeNull()
  })

  // grep sets `show_version` and keeps scanning, printing after the loop, so a
  // refusal anywhere outranks the answer; ripgrep's clap parse is whole-line
  // for the same reason. Measured on grep 3.11 and ripgrep 14.1.1: both
  // `--version --bogus` lines exit 2.
  it('makes the deferred family read the whole line', () => {
    for (const name of ['grep', 'rg']) {
      expect(standardRequest(name, builtinSpec(name), ['--version'])).not.toBeNull()
      expect(standardRequest(name, builtinSpec(name), ['--version', '--bogus'])).toBeNull()
      expect(standardRequest(name, builtinSpec(name), ['--bogus', '--version'])).toBeNull()
    }
  })

  // zgrep is a shell script whose own loop answers before it ever builds a grep
  // command, so no refusal outranks it (measured on gzip 1.13: `zgrep --bogus
  // --version f.gz` prints the version, exit 0, where `zgrep --bogus f.gz`
  // reaches grep and exits 2).
  it('lets zgrep answer ahead of every refusal', () => {
    expect(standardRequest('zgrep', builtinSpec('zgrep'), ['--bogus', '--version'])).not.toBeNull()
  })

  // A value-taking option swallows the word, so it is that option's value and
  // never an option at all: `grep -e --version f` greps for the pattern
  // `--version` and exits 1 on grep 3.11.
  it('lets a value-taking option swallow the word', () => {
    expect(standardRequest('grep', builtinSpec('grep'), ['-e', '--version'])).toBeNull()
    expect(standardRequest('grep', builtinSpec('grep'), ['--include', '--version'])).toBeNull()
  })

  // GNU answers both standard options from one long_options table, so they are
  // ordered against each other by scan position like any other pair: measured
  // on coreutils 9.7, `cat --help --version` is the help page and
  // `cat --version --help` is the version line. The version half used to be
  // the only one served here, so it won wherever it sat. Mirrors test_config.py.
  it('lets the first standard option the scan reaches win', () => {
    const spec = builtinSpec('cat')
    const page = decode(standardRequest('cat', spec, ['--help', '--version']))
    expect(page).toContain('Usage: cat')
    expect(decode(standardRequest('cat', spec, ['--version', '--help']))).toMatch(/^cat \(Mirage\)/)
    expect(decode(standardRequest('cat', spec, ['--h', '--v']))).toContain('Usage: cat')
  })

  // --help is served here for the same reason --version is: the cross-mount
  // branch bypasses the registered wrapper that answers it, so
  // `mv --help /ram/a /disk/b` ran the relay and moved the file. The page must
  // be the one the wrapper would have printed, GNU's synopsis line included,
  // which is why helpPage takes either form of the builtin's grammar.
  // Mirrors test_config.py.
  it('serves help from either form of the grammar', () => {
    for (const name of ['mv', 'cp', 'cat', 'rm']) {
      const page = decode(standardRequest(name, builtinSpec(name), ['--help']))
      expect(page).toContain(`Usage: ${name}`)
    }
  })

  // The scan-order and family rules hold for help exactly as for the version,
  // measured rather than assumed: on coreutils 9.7 `cat --bogus --help`
  // reports the option and `cat --help --bogus` prints the page; on grep 3.11
  // BOTH orders report the option; on gzip 1.13 `zgrep --bogus --help` prints
  // zgrep's own usage and exits 0. Mirrors test_config.py.
  it('follows the same scan order and families for help', () => {
    const cat = builtinSpec('cat')
    expect(standardRequest('cat', cat, ['--bogus', '--help'])).toBeNull()
    expect(standardRequest('cat', cat, ['--help', '--bogus'])).not.toBeNull()
    for (const name of ['grep', 'rg']) {
      const spec = builtinSpec(name)
      expect(standardRequest(name, spec, ['--help'])).not.toBeNull()
      expect(standardRequest(name, spec, ['--help', '--bogus'])).toBeNull()
      expect(standardRequest(name, spec, ['--bogus', '--help'])).toBeNull()
    }
    expect(standardRequest('zgrep', builtinSpec('zgrep'), ['--bogus', '--help'])).not.toBeNull()
  })

  // The position comes from the parser, not from a raw lookalike: `-e` takes
  // `--` as its pattern, so the line is NOT ended and the `--version` after it
  // is the option; `-o` takes the first `--version` as its output file and the
  // second is the option. The raw scan stopped at the consumed word and
  // declined, which on a cross-mount line let the fan-out print one version
  // page per operand. Mirrors test_config.py.
  it('takes the position from the parser, not a lookalike', () => {
    const grep = builtinSpec('grep')
    expect(decode(standardRequest('grep', grep, ['-e', '--', '--version']))).toMatch(
      /^grep \(Mirage\)/,
    )
    expect(
      decode(standardRequest('sort', builtinSpec('sort'), ['-o', '--version', '--version'])),
    ).toMatch(/^sort \(Mirage\)/)
    // A real end-of-options marker still ends the scan.
    expect(standardRequest('grep', grep, ['--', '--version'])).toBeNull()
  })

  // A declared remainder slot is argparse's REMAINDER: the first operand ends
  // option parsing, so every word after it belongs to the program being run
  // rather than to mirage. Verified against argparse itself --
  // `add_argument("--version", action="store_true")` plus
  // `add_argument("rest", nargs=REMAINDER)` answers `["operand", "--version"]`
  // with `version=False` and the flag in `rest`. mirage's parser already
  // agreed; only this scan did not, so `mytool operand --version` printed
  // mirage's version and the handler never ran. Mirrors test_config.py.
  it('keeps the words after a remainder operand', () => {
    const rest = specFor(
      'mytool',
      new CommandSpec({ rest: new Operand({ type: 'str', remainder: true }) }),
    )
    expect(standardRequest('mytool', rest, ['operand', '--version'])).toBeNull()
    expect(standardRequest('mytool', rest, ['operand', '--vers'])).toBeNull()
    // Ahead of the first operand it is still an option, as argparse answers
    // `["--version", "operand"]` with version=true.
    expect(standardRequest('mytool', rest, ['--version', 'operand'])).not.toBeNull()
    expect(standardRequest('mytool', rest, ['--version'])).not.toBeNull()
  })

  // The four builtin specs that declare a remainder (python, python3, node,
  // js) all declare their own --version too, so none of them ever reaches the
  // scan: the wrapper injects nothing and this declines on the first line.
  // Pinned so a spec losing its own --version cannot quietly hand its
  // program's argv to mirage. Mirrors test_config.py.
  it('never reaches the scan for the builtin remainder specs', () => {
    for (const name of ['python', 'python3', 'node', 'js']) {
      const spec = builtinSpec(name)
      expect(hasInjectedVersion(spec)).toBe(false)
      expect(standardRequest(name, spec, ['-c', 'code', '--vers'])).toBeNull()
    }
  })

  // Both tables name one real program, so both are gated on the spec being that
  // program's own grammar. A mount may register a command under a builtin's
  // name, and neither gnulib's deferral nor zgrep's precedence is a fact about
  // that command.
  it('does not let a borrowed name borrow the family', () => {
    for (const name of ['grep', 'zgrep']) {
      const borrowed = specFor(name, new CommandSpec({ rest: new Operand({ type: 'str' }) }))
      expect(standardRequest(name, borrowed, ['--version', '--bogus'])).not.toBeNull()
      expect(standardRequest(name, borrowed, ['--bogus', '--version'])).toBeNull()
    }
  })
})
