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

import { ARGPARSE_EXIT, gitUnknownOption, leafRefusal } from './refusal.js'
import { UsageStyle } from './types.js'

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
