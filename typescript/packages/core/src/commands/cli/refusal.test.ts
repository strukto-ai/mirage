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
  ARGPARSE_EXIT,
  clapMissingOperands,
  clapSupplied,
  gitUnknownOption,
  leafRefusal,
} from './refusal.js'
import { CommandSpec, Operand, Option, UsageStyle } from '../spec/types.js'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const ARGPARSE_MESSAGE = ENC.encode("gws gmail: unrecognized option '--nosuch'\n")

// Pinned against git 2.50.1: `git status --nosuch` and `git status -Z`.
describe('gitUnknownOption', () => {
  it('names a long option without its dashes', () => {
    expect(DEC.decode(gitUnknownOption('--nosuch'))).toBe("error: unknown option `nosuch'\n")
  })

  it('calls a short option a switch', () => {
    expect(DEC.decode(gitUnknownOption('Z'))).toBe("error: unknown switch `Z'\n")
  })

  it('strips a dashed short token too', () => {
    expect(DEC.decode(gitUnknownOption('-Z'))).toBe("error: unknown switch `Z'\n")
  })
})

describe('leafRefusal', () => {
  it('exits 129 under the git style', () => {
    const [, code] = leafRefusal(UsageStyle.GIT, ARGPARSE_MESSAGE, ['--nosuch'])
    expect(code).toBe(129)
  })

  it('replaces the argparse wording under the git style', () => {
    const [msg] = leafRefusal(UsageStyle.GIT, ARGPARSE_MESSAGE, ['--nosuch'])
    expect(DEC.decode(msg)).toBe("error: unknown option `nosuch'\n")
  })

  it('leaves the default style exactly as it was', () => {
    // Every other installed CLI has to keep argparse's shape and its exit 2:
    // an installed name is not a GNU tool with a pinned exit.
    const [msg, code] = leafRefusal(UsageStyle.ARGPARSE, ARGPARSE_MESSAGE, ['--nosuch'])
    expect(msg).toBe(ARGPARSE_MESSAGE)
    expect(code).toBe(ARGPARSE_EXIT)
  })

  it('keeps the argparse wording for errors git shares', () => {
    // A missing value on a flag git does declare is not the unknown option
    // case, so only the exit code moves.
    const [msg, code] = leafRefusal(UsageStyle.GIT, ARGPARSE_MESSAGE, [])
    expect(msg).toBe(ARGPARSE_MESSAGE)
    expect(code).toBe(129)
  })
})

// Pinned against the real ntn 0.21.9; integ/ntn_conformance.ts runs the same
// lines through it.
describe('clap refusals', () => {
  it('names the empty slot and echoes what was supplied', () => {
    const spec = new CommandSpec({
      options: [new Option({ long: '--json', type: 'bool' })],
      positional: [new Operand({ type: 'str', name: 'PAGE_ID', required: true })],
    })
    const msg = clapMissingOperands('ntn pages get', spec, ['PAGE_ID'], ['--json'], {})
    expect(DEC.decode(msg)).toBe(
      'error: the following required arguments were not provided:\n' +
        '  <PAGE_ID>\n\n' +
        'Usage: ntn pages get --json <PAGE_ID>\n\n' +
        "For more information, try '--help'.\n",
    )
  })

  it('echoes typed options in the order they were typed', () => {
    const spec = new CommandSpec({
      options: [
        new Option({ long: '--limit', type: 'int' }),
        new Option({ long: '--sort', type: 'str' }),
      ],
    })
    // No metavar declared, so both names derive from the long spelling.
    expect(clapSupplied(spec, ['--limit', '--sort'], {})).toEqual([
      '--limit <LIMIT>',
      '--sort <SORT>',
    ])
    expect(clapSupplied(spec, ['--sort', '--limit'], {})).toEqual([
      '--sort <SORT>',
      '--limit <LIMIT>',
    ])
  })

  it('appends env-sourced options after the typed ones', () => {
    const spec = new CommandSpec({
      options: [
        new Option({ long: '--json', type: 'bool' }),
        new Option({
          long: '--notion-version',
          type: 'str',
          metavar: 'VERSION',
          env: 'NOTION_API_VERSION',
        }),
      ],
    })
    const env = { NOTION_API_VERSION: '2025-09-03' }
    expect(clapSupplied(spec, ['--json'], env)).toEqual(['--json', '--notion-version <VERSION>'])
    // Unset, it is simply not supplied.
    expect(clapSupplied(spec, ['--json'], {})).toEqual(['--json'])
  })

  it('omits a merely defaulted option', () => {
    // GNU-style defaults are invisible to clap's usage line: only what the line
    // carried (or an env supplied) is echoed.
    const spec = new CommandSpec({
      options: [new Option({ long: '--limit', type: 'int', default: '25' })],
    })
    expect(clapSupplied(spec, [], {})).toEqual([])
  })

  it('exits 2 like argparse but for its own reason', () => {
    const [msg, code] = leafRefusal(UsageStyle.CLAP, ARGPARSE_MESSAGE, [])
    expect(msg).toBe(ARGPARSE_MESSAGE)
    expect(code).toBe(2)
  })
})
