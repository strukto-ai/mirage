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
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { RAMResource } from '../../resource/ram/ram.ts'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  createShellParser,
  findSyntaxError,
  findUnterminatedBacktick,
  type ShellParser,
} from './index.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let parser: ShellParser

beforeAll(async () => {
  parser = await createShellParser({ engineWasm, grammarWasm })
})

describe('findSyntaxError', () => {
  it.each([
    'if then fi',
    'echo (',
    'for x do done',
    'for',
    'if',
    'if; fi',
    'echo "unterm',
    ';s',
    '| s',
    '&& s',
    '& s',
    'echo a ; ; echo b',
    'echo bg &; echo fg',
    'true;;s',
    'echo a ;& echo b',
  ])('flags structural syntax error in %j', (cmd) => {
    const root = parser.parse(cmd)
    expect(findSyntaxError(root)).not.toBeNull()
  })

  it.each([
    'echo hi',
    'for x in a b; do echo $x; done',
    'if true; then echo y; fi',
    'cat /tmp/x | sort',
    "cat <<EN'D'\n$v\nEND",
    'echo bg & echo fg',
    'echo a &',
    'echo a;',
    'case x in a) echo a;; esac',
    'case x in a) echo a;& b) echo b;;& c) echo c;; esac',
    'for x in; do echo $x; done',
  ])('returns null for valid / recoverable %j', (cmd) => {
    const root = parser.parse(cmd)
    expect(findSyntaxError(root)).toBeNull()
  })

  it.each([
    [';s', ';'],
    ['| s', '|'],
    ['&& s', '&&'],
    ['echo a ; ; echo b', ';'],
    ['echo bg &; echo fg', ';'],
    ['true;;s', ';;'],
  ])('names the stray separator in %j', (cmd, token) => {
    const root = parser.parse(cmd)
    expect(findSyntaxError(root)?.trim()).toBe(token)
  })
})

describe('findUnterminatedBacktick', () => {
  it.each(['echo `echo a', 'echo "`echo \'`\'`"', 'echo a`', '`'])(
    'flags the open region in %j',
    (command) => {
      expect(findUnterminatedBacktick(command)).not.toBeNull()
    },
  )

  it.each([
    'echo `echo a`',
    'echo `echo a` `echo b`',
    // Single quotes protect a backtick, double quotes do not.
    "echo '`'",
    'echo "`echo a`"',
    'echo "\\`"',
    // Only a backslash escapes inside the region.
    'echo `echo \\`nested\\``',
    'echo a',
    'cat <<EOF\nplain\nEOF',
  ])('accepts balanced %j', (command) => {
    expect(findUnterminatedBacktick(command)).toBeNull()
  })
})

const missingQuoteCases = JSON.parse(
  readFileSync(
    new URL('../../../../../../integ/bash/syntax/quoting.json', import.meta.url),
    'utf8',
  ),
) as { cases: { command: string; expect: { exit: number } }[] }
it.each(missingQuoteCases.cases.filter((c) => c.expect.exit === 2).map((c) => c.command))(
  'missing nested quote refuses before any execution: %s',
  async (command) => {
    const ws = new Workspace({ '/data': new RAMResource() }, { shellParser: parser })
    try {
      const io = await ws.execute(command)
      expect(io.exitCode).toBe(2)
      expect(new TextDecoder().decode(io.stdout)).toBe('')
      expect(new TextDecoder().decode(io.stderr)).toContain('syntax error')
      expect((await ws.execute('test -e /data/unexpected')).exitCode).toBe(1)
    } finally {
      await ws.close()
    }
  },
)
