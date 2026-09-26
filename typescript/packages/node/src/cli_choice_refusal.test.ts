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
import type { CLISpec } from '@struktoai/mirage-core/commands/cli/types'
import { cliSpecFor } from '@struktoai/mirage-core/commands/cli/specs'
import { MountMode } from '@struktoai/mirage-core/types'
import { RAMResource } from '@struktoai/mirage-core/resource/ram/ram'
import { HF } from './commands/cli/builtin/hf/index.ts'
import { HIMALAYA } from './commands/cli/builtin/himalaya/index.ts'
import { Workspace } from './workspace.ts'

const DEC = new TextDecoder()

// hf and himalaya are node CLIs, so core's registry does not know them;
// gh and git come from there.
const SPEC_OF: Record<string, CLISpec> = { hf: HF, himalaya: HIMALAYA }

function specFor(name: string): CLISpec {
  return SPEC_OF[name] ?? cliSpecFor(name)
}

// Every CLI-tier option that declares `choices` renders through the same
// gnulib ARGMATCH block a coreutils command does, because a leaf parses
// with the ordinary spec machinery. What a CLI adds is the display path
// in place of a command name, and its dialect's exit code. The
// expectation is CHOSEN rather than measured: none of these is a GNU
// program, so there is no host binary to pin the wording against. Lives
// here rather than in core because hf and himalaya are node CLIs.
// Mirrors python's `test_a_cli_leaf_refuses_a_choice_in_the_argmatch_block`.
describe('a CLI leaf refusing a choice', () => {
  it.each<
    [string, Record<string, unknown> | null, string, string, string, string, string[], number]
  >([
    [
      'gh',
      { token: 't' },
      'gh issue list --state=x',
      'gh issue list',
      '--state',
      'x',
      ['open', 'closed', 'all'],
      2,
    ],
    [
      'gh',
      { token: 't' },
      'gh pr list --state=x',
      'gh pr list',
      '--state',
      'x',
      ['open', 'closed', 'merged', 'all'],
      2,
    ],
    [
      'hf',
      { token: 't' },
      'hf download --repo-type=x owner/repo file',
      'hf download',
      '--repo-type',
      'x',
      ['model', 'dataset', 'space'],
      2,
    ],
    [
      'hf',
      { token: 't' },
      'hf repo create --space_sdk=x owner/repo',
      'hf repo create',
      '--space_sdk',
      'x',
      ['gradio', 'streamlit', 'docker', 'static'],
      2,
    ],
    [
      'himalaya',
      { imap_host: 'h', smtp_host: 'h', username: 'u', password: 'p' },
      'himalaya message reply --posting-style=x 1',
      'himalaya message reply',
      '--posting-style',
      'x',
      ['top', 'bottom'],
      2,
    ],
    // git is the one GIT-dialect install, so it is also the one that
    // answers the block with 129 rather than argparse's 2.
    [
      'git',
      null,
      'git status --untracked-files=bogus',
      'git status',
      '--untracked-files',
      'bogus',
      ['no', 'normal', 'all'],
      129,
    ],
  ])(
    'refuses %s in the argmatch block',
    async (name, config, line, path, option, bad, choices, exitCode) => {
      const ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
      ws.registerCli(name, specFor(name), config)
      const result = await ws.execute(line)
      const valid = choices.map((c) => `  - '${c}'`).join('\n')
      expect(DEC.decode(result.stderr)).toBe(
        `${path}: invalid argument '${bad}' for '${option}'\n` +
          `Valid arguments are:\n${valid}\n` +
          `Try '${path} --help' for more information.\n`,
      )
      expect(result.exitCode).toBe(exitCode)
      await ws.close()
    },
  )
})

// Pinned against git 2.47.3. git's parse-options runs the whole option
// scan first and reports an unrecognized option from it, and only then
// does the command validate a value it did accept, so under the GIT
// dialect an unknown option outranks a bad value WHEREVER the two sit on
// the line -- the opposite of the scan-order rule every coreutils command
// follows. Do not "fix" leafRefusal to report the first error in line
// order: that reads as consistency and is a divergence from git.
describe('git reporting an unknown option over an earlier bad value', () => {
  it.each([
    'git status --untracked-files=bogus --bogus',
    'git status --bogus --untracked-files=bogus',
  ])('answers unknown option for %s', async (line) => {
    const ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
    ws.registerCli('git', cliSpecFor('git'))
    const result = await ws.execute(line)
    expect(DEC.decode(result.stderr)).toBe("error: unknown option `bogus'\n")
    expect(result.exitCode).toBe(129)
    await ws.close()
  })
})
