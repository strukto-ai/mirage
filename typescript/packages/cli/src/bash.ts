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

import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { ENV_SESSION, ENV_WORKSPACE } from './env.ts'
import { main as cliMain } from './main.ts'

/**
 * Opt in by assigning a debug sink, as Python's module logger is off until
 * configured: stdout carries the line's output.
 */
export const logger: { debug?: (message: string) => void } = {}

export const PROG = 'mirage-bash'

/**
 * The line a shell's arguments run: options first, `-c` among them, then the
 * line as the first operand. Other options are read and dropped, since the
 * line runs in a Mirage session, not a host shell; `-o` and `-O` take the
 * next argument with them. Throws on no `-c`, no line after it, or operands
 * after it. Mirrors Python's `split_args`.
 */
export function splitArgs(argv: string[]): string {
  const rest = [...argv]
  let command = false
  for (let flag = rest[0]; flag?.startsWith('-') === true && flag !== '-'; flag = rest[0]) {
    rest.shift()
    if (flag === '--') break
    if (flag.startsWith('--')) continue
    command ||= flag.includes('c')
    if ((flag.includes('o') || flag.includes('O')) && rest.length > 0) rest.shift()
  }
  if (!command) throw new Error('only -c is supported')
  const [line, ...extra] = rest
  if (line === undefined) throw new Error('-c: option requires an argument')
  if (extra.length > 0) throw new Error('operands after the line are not supported')
  return line
}

/**
 * The process's working directory as a shell names it: `$PWD` when that
 * names the same directory, so a symlinked path keeps its name, else the
 * resolved path.
 */
export function workingDirectory(): string {
  const cwd = process.cwd()
  const logical = process.env.PWD ?? ''
  if (!isAbsolute(logical)) return cwd
  try {
    const named = statSync(logical)
    const actual = statSync(cwd)
    return named.dev === actual.dev && named.ino === actual.ino ? logical : cwd
  } catch (error) {
    logger.debug?.(`PWD ${logical} is not the working directory: ${String(error)}`)
    return cwd
  }
}

/**
 * Run `mirage-bash -c LINE` as `mirage shell`: on the workspace
 * `MIRAGE_WORKSPACE` names, as the session `MIRAGE_SESSION` names (the
 * default one when unset), from the process's working directory. A coding
 * agent that takes a shell path runs its commands this way.
 */
export async function main(argv: string[]): Promise<void> {
  let line: string
  try {
    line = splitArgs(argv)
  } catch (error) {
    console.error(`${PROG}: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
  const workspace = process.env[ENV_WORKSPACE] ?? ''
  if (workspace === '') {
    console.error(`${PROG}: ${ENV_WORKSPACE} is not set`)
    process.exit(2)
  }
  const args = ['shell', '-w', workspace, `--cwd=${workingDirectory()}`]
  const session = process.env[ENV_SESSION] ?? ''
  if (session !== '') args.push('-s', session)
  await cliMain([...args, `--command=${line}`])
}
