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
import { makeClient, type DaemonClient } from './client.ts'
import { emit, exitCodeFromResponse, fail, handleResponse } from './output.ts'
import { loadDaemonSettings } from './settings.ts'

const WAIT_SLICE_S = 30
const INTERRUPTED = 130

/** Wait until a daemon job settles. */
async function waitJob(
  client: DaemonClient,
  jobId: string,
): Promise<{ status: string; finished_at: number | null; result: unknown; error: string | null }> {
  for (;;) {
    const job = (await handleResponse(
      await client.request('POST', `/v1/jobs/${jobId}/wait`, {
        body: JSON.stringify({ timeout_s: WAIT_SLICE_S }),
      }),
    )) as Awaited<ReturnType<typeof waitJob>>
    if (job.finished_at !== null) return job
  }
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
 * Run a shell line in a workspace. The line is a daemon job. With piped
 * stdin it is one request that streams the input to the line as it
 * reads it, so the line starts before the input ends; Ctrl-C drops the
 * request, which cancels the job, and exits 130. Without piped stdin it
 * is submitted, then waited on, and Ctrl-C, from the submit on, cancels
 * it through `DELETE /v1/jobs/:id`. `--bg` returns the job id at once
 * instead, after any piped stdin has been sent.
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
      }) => {
        const body: Record<string, unknown> = { command: opts.command }
        if (opts.cwd !== undefined) body.cwd = opts.cwd
        if (opts.runtime !== undefined) body.runtime = opts.runtime
        const session =
          opts.session === undefined ? '' : `session_id=${encodeURIComponent(opts.session)}`
        const path = `/v1/workspaces/${encodeURIComponent(opts.workspace)}/shell`
        const c = makeClient(loadDaemonSettings())
        await c.ensureRunning({ allowSpawn: false })
        if (opts.explain === true) {
          const query = session === '' ? '?explain=true' : `?${session}&explain=true`
          const r = await c.request('POST', `${path}${query}`, { body: JSON.stringify(body) })
          emit((await handleResponse(r)) as ExplanationRecord, formatExplanation)
          return
        }
        const foreground = session === '' ? path : `${path}?${session}`
        const background = session === '' ? `${path}?background=true` : `${path}?${session}&background=true`
        const piped = !process.stdin.isTTY
        if (piped && opts.bg !== true) {
          const stop = new AbortController()
          const interrupt = (): void => {
            stop.abort()
          }
          process.on('SIGINT', interrupt)
          let answered: Response
          try {
            answered = await c.requestUpload(
              'POST',
              foreground,
              body,
              { name: 'stdin', data: process.stdin },
              stop.signal,
            )
          } catch (error) {
            if (stop.signal.aborted) process.exit(INTERRUPTED)
            throw error
          } finally {
            process.off('SIGINT', interrupt)
          }
          if (answered.status === 499) fail('job canceled', INTERRUPTED)
          const result = await handleResponse(answered)
          emit(result)
          process.exitCode = exitCodeFromResponse(result)
          return
        }
        const state: { interrupted: boolean; jobId?: string } = { interrupted: false }
        const interrupt = (): void => {
          if (state.interrupted) return
          state.interrupted = true
          if (state.jobId !== undefined) void c.request('DELETE', `/v1/jobs/${state.jobId}`)
        }
        if (opts.bg !== true) process.on('SIGINT', interrupt)
        let job: Awaited<ReturnType<typeof waitJob>>
        try {
          const submittedResponse = piped
            ? await c.requestUpload('POST', background, body, {
                name: 'stdin',
                data: process.stdin,
              })
            : await c.request('POST', background, { body: JSON.stringify(body) })
          const submitted = (await handleResponse(submittedResponse)) as { job_id: string }
          if (opts.bg === true) {
            emit(submitted)
            return
          }
          state.jobId = encodeURIComponent(submitted.job_id)
          if (state.interrupted) await c.request('DELETE', `/v1/jobs/${state.jobId}`)
          job = await waitJob(c, state.jobId)
        } finally {
          process.off('SIGINT', interrupt)
        }
        if (state.interrupted) process.exit(INTERRUPTED)
        if (job.status === 'failed') fail(`shell failed: ${String(job.error)}`, 2)
        if (job.status === 'canceled') fail('job canceled', INTERRUPTED)
        emit(job.result)
        process.exitCode = exitCodeFromResponse(job.result)
      },
    )
}
