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

import { fstatSync, statSync } from 'node:fs'
import { devNull } from 'node:os'
import type { Command } from 'commander'
import { makeClient } from './client.ts'
import { resolveWorkspace } from './settings.ts'
import { emit, fail } from './output.ts'
import { answer, post, WORKSPACE_FLAGS, WORKSPACE_HELP } from './vfs.ts'

/**
 * Whether a descriptor that is no terminal may carry input for the line: an
 * empty file or the null device has none to send, and a line without input
 * can have what a machine's program prints streamed. Mirrors Python's
 * `_has_input`.
 */
export function hasInput(fd: number): boolean {
  const info = fstatSync(fd)
  if (info.isFile()) return info.size > 0
  const none = statSync(devNull)
  return !(info.dev === none.dev && info.ino === none.ino)
}

interface ExplainedNode {
  type: string
  text: string
  outcome?: string
  exit_code?: number
  reason?: string
  source?: string
  runtime?: string
  children: ExplainedNode[]
}

export interface ExplanationRecord {
  line: string
  outcome: string
  reason: string
  answers: { kind: string; runtime?: string; reason?: string | null }[]
  exit_code: number
  node: ExplainedNode
}

/** An explained line as a tree, one node a row, each command with its verdict. */
export function formatExplanation(data: ExplanationRecord): string {
  let verdict = `${data.outcome}, exit ${String(data.exit_code)}`
  if (data.reason !== '') verdict += `: ${data.reason}`
  const out = [`${data.line}  [${verdict}]`]
  for (const answer of data.answers) {
    if (answer.kind === 'route' && answer.reason) {
      out.push(`  on ${answer.runtime ?? ''}: ${answer.reason}`)
    }
  }
  for (const child of data.node.children) explainedLines(child, 1, out)
  return out.join('\n')
}

/** Append one node of an explained line, and what it holds, as rows. */
function explainedLines(node: ExplainedNode, depth: number, out: string[]): void {
  const pad = '  '.repeat(depth)
  if (node.outcome === undefined) {
    out.push(`${pad}${node.type}: ${node.text}`)
  } else {
    let line = `${pad}${node.text}  [${node.outcome}`
    if (node.exit_code !== undefined && node.exit_code !== 0)
      line += `, exit ${String(node.exit_code)}`
    line += node.reason !== undefined && node.reason !== '' ? `: ${node.reason}]` : ']'
    if (node.source !== undefined && node.source !== '') line += `  ${node.source}`
    if (node.runtime !== undefined && node.runtime !== '') line += `  on ${node.runtime}`
    out.push(line)
  }
  for (const child of node.children) explainedLines(child, depth + 1, out)
}

/**
 * Run a shell line with raw stdout and stderr streamed as bytes. `--json`
 * collects the same streams into the final result. Piped stdin uploads
 * concurrently in either mode, and Ctrl-C cancels the request with exit130.
 * `--no-record` keeps the line out of the session's history. `--explain`
 * runs nothing.
 */
export function registerShellCommand(parent: Command): void {
  parent
    .command('shell')
    .description('Run a shell line in a workspace.')
    .option(WORKSPACE_FLAGS, WORKSPACE_HELP)
    .requiredOption('-c, --command <command>', 'Shell line to run')
    .option('-s, --session <id>', 'Session id')
    .option('--cwd <path>', 'Working directory for this line (a workspace path)')
    .option('--runtime <name>', "Workspace runtime entry to place this line's captured stages on")
    .option(
      '--machine <name>',
      "Machine to run this line's captured stages on, by its name under machines:",
    )
    .option('--no-record', "Keep this line out of the session's history")
    .option('--json', 'Collect output and print the final result as JSON')
    .option('--explain', 'Say what the line would do, as a tree; run nothing')
    .action(
      async (opts: {
        workspace?: string
        command: string
        session?: string
        cwd?: string
        runtime?: string
        machine?: string
        record: boolean
        explain?: boolean
        json?: boolean
      }) => {
        const workspace = resolveWorkspace(opts.workspace)
        const body: Record<string, unknown> = { command: opts.command }
        if (opts.cwd !== undefined) body.cwd = opts.cwd
        if (opts.runtime !== undefined) body.runtime = opts.runtime
        if (opts.machine !== undefined) body.machine = opts.machine
        if (!opts.record) body.record = false
        if (opts.explain === true) {
          const said = await answer(await post({ ...opts, workspace }, 'shell', body))
          emit(said as ExplanationRecord, opts.json === true ? undefined : formatExplanation)
          return
        }
        const session =
          opts.session === undefined ? '' : `session_id=${encodeURIComponent(opts.session)}`
        const path = `/v1/workspaces/${encodeURIComponent(workspace)}/shell`
        const c = makeClient()
        await c.ensureRunning({ allowSpawn: false })
        const { streamShell } = await import('./stream.ts')
        try {
          process.exitCode = await streamShell(
            c,
            session === '' ? `${path}?stream=true` : `${path}?${session}&stream=true`,
            body,
            !process.stdin.isTTY && hasInput(0),
            opts.json === true,
          )
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error), 2)
        }
      },
    )
}
