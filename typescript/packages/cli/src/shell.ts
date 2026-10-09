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

import type { Command } from 'commander'
import { makeClient } from './client.ts'
import { emit, fail, handleResponse } from './output.ts'
import { loadDaemonSettings } from './settings.ts'
import { answer, post } from './vfs.ts'

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
  exit_code: number
  node: ExplainedNode
}

/** An explained line as a tree, one node a row, each command with its verdict. */
export function formatExplanation(data: ExplanationRecord): string {
  let verdict = `${data.outcome}, exit ${String(data.exit_code)}`
  if (data.reason !== '') verdict += `: ${data.reason}`
  const out = [`${data.line}  [${verdict}]`]
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
 * `--bg` returns the job id after stdin uploads; `--explain` runs nothing.
 */
export function registerShellCommand(program: Command): void {
  program
    .command('shell')
    .description('Run a shell line in a workspace.')
    .requiredOption('-w, --workspace <id>', 'Workspace id')
    .requiredOption('-c, --command <command>', 'Shell line to run')
    .option('-s, --session <id>', 'Session id')
    .option('--cwd <path>', 'Working directory for this line (a workspace path)')
    .option('--runtime <name>', "Workspace runtime entry to place this line's captured stages on")
    .option('--bg', 'Background; return job_id immediately')
    .option('--json', 'Collect output and print the final result as JSON')
    .option('--explain', 'Say what the line would do, as a tree; run nothing')
    .action(
      async (opts: {
        workspace: string
        command: string
        session?: string
        cwd?: string
        runtime?: string
        bg?: boolean
        explain?: boolean
        json?: boolean
      }) => {
        const body: Record<string, unknown> = { command: opts.command }
        if (opts.cwd !== undefined) body.cwd = opts.cwd
        if (opts.runtime !== undefined) body.runtime = opts.runtime
        if (opts.explain === true) {
          const said = await answer(await post(opts, 'shell', body))
          emit(said as ExplanationRecord, opts.json === true ? undefined : formatExplanation)
          return
        }
        const session =
          opts.session === undefined ? '' : `session_id=${encodeURIComponent(opts.session)}`
        const path = `/v1/workspaces/${encodeURIComponent(opts.workspace)}/shell`
        const c = makeClient(loadDaemonSettings())
        await c.ensureRunning({ allowSpawn: false })
        const foreground = session === '' ? path : `${path}?${session}`
        const background =
          session === '' ? `${path}?background=true` : `${path}?${session}&background=true`
        const piped = !process.stdin.isTTY
        if (opts.bg !== true) {
          const { streamShell } = await import('./stream.ts')
          try {
            process.exitCode = await streamShell(
              c,
              `${foreground}${session === '' ? '?' : '&'}stream=true`,
              body,
              piped,
              opts.json === true,
            )
          } catch (error) {
            fail(error instanceof Error ? error.message : String(error), 2)
          }
          return
        }
        const response = piped
          ? await c.requestUpload('POST', background, body, { name: 'stdin', data: process.stdin })
          : await c.request('POST', background, { body: JSON.stringify(body) })
        emit(await handleResponse(response))
      },
    )
}
