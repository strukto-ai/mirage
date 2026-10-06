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

import { buffer } from 'node:stream/consumers'
import type { Command } from 'commander'
import { makeClient } from './client.ts'
import { emit, handleResponse } from './output.ts'
import { loadDaemonSettings } from './settings.ts'

interface Target {
  workspace: string
  session?: string
}

/**
 * Run one tool through the daemon's route and print its answer: JSON, or
 * the tool's text on a terminal. Exits 1 when the tool failed.
 */
async function callTool(
  target: Target,
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  const c = makeClient(loadDaemonSettings())
  await c.ensureRunning({ allowSpawn: false })
  const query =
    target.session === undefined ? '' : `?session_id=${encodeURIComponent(target.session)}`
  const path = `/v1/workspaces/${encodeURIComponent(target.workspace)}/${name}${query}`
  const response = (await handleResponse(
    await c.request('POST', path, { body: JSON.stringify(args) }),
  )) as { text: string; is_error: boolean }
  emit(response, (r) => r.text)
  if (response.is_error) process.exitCode = 1
}

function toolCommand(program: Command, name: string, description: string): Command {
  return program
    .command(name)
    .description(description)
    .requiredOption('-w, --workspace <id>', 'Workspace id')
    .option('-s, --session <id>', 'Session id')
}

/** The tools beside `shell`, one verb each, run as MCP runs them. */
export function registerToolCommands(program: Command): void {
  toolCommand(program, 'read', 'Read a file with line numbers.')
    .argument('<path>', 'File to read')
    .option('--offset <n>', 'Line to start at (0-based)', Number)
    .option('--limit <n>', 'Most lines to return', Number)
    .action(async (path: string, opts: Target & { offset?: number; limit?: number }) => {
      const args: Record<string, unknown> = { path }
      if (opts.offset !== undefined) args.offset = opts.offset
      if (opts.limit !== undefined) args.limit = opts.limit
      await callTool(opts, 'read', args)
    })
  toolCommand(program, 'write', 'Write a file; an existing one must be read in full first.')
    .argument('<path>', 'File to write')
    .option('--content <text>', 'Text to write; stdin when absent')
    .action(async (path: string, opts: Target & { content?: string }) => {
      const content = opts.content ?? (await buffer(process.stdin)).toString('utf-8')
      await callTool(opts, 'write', { path, content })
    })
  toolCommand(program, 'edit', 'Replace a string in an existing file.')
    .argument('<path>', 'File to edit')
    .argument('<old>', 'The exact text to replace')
    .argument('<new>', 'The text to put in its place')
    .option('--replace-all', 'Replace every occurrence')
    .action(
      async (
        path: string,
        oldString: string,
        newString: string,
        opts: Target & { replaceAll?: boolean },
      ) => {
        await callTool(opts, 'edit', {
          path,
          old_string: oldString,
          new_string: newString,
          replace_all: opts.replaceAll === true,
        })
      },
    )
  toolCommand(program, 'ls', 'List a directory.')
    .argument('<path>', 'Directory to list')
    .action(async (path: string, opts: Target) => {
      await callTool(opts, 'ls', { path })
    })
  toolCommand(program, 'grep', 'Search files recursively, as grep -rn does.')
    .argument('<pattern>', 'Regular expression to search for')
    .argument('<path>', 'File or directory to search under')
    .option('-i, --ignore-case', 'Match case-insensitively')
    .option('-F, --fixed-strings', 'Read the pattern as a literal string')
    .option('--include <glob>', 'Search only files whose name matches the glob')
    .option('-C, --context <n>', 'Lines of context around each match', Number)
    .option('-l, --files-with-matches', 'Print only the names of matching files')
    .option('-c, --count', 'Print only a count of matching lines per file')
    .option('-m, --max-count <n>', 'Stop each file after this many matches', Number)
    .action(
      async (
        pattern: string,
        path: string,
        opts: Target & {
          ignoreCase?: boolean
          fixedStrings?: boolean
          include?: string
          context?: number
          filesWithMatches?: boolean
          count?: boolean
          maxCount?: number
        },
      ) => {
        const args: Record<string, unknown> = { pattern, path }
        if (opts.ignoreCase === true) args.ignore_case = true
        if (opts.fixedStrings === true) args.fixed_strings = true
        if (opts.include !== undefined) args.include = opts.include
        if (opts.context !== undefined) args.context = opts.context
        if (opts.filesWithMatches === true) args.files_with_matches = true
        if (opts.count === true) args.count = true
        if (opts.maxCount !== undefined) args.max_count = opts.maxCount
        await callTool(opts, 'grep', args)
      },
    )
  toolCommand(program, 'glob', 'Find files whose path matches a pattern.')
    .argument('<pattern>', 'Pathname pattern such as **/*.py')
    .argument('[path]', 'Directory a relative pattern is matched under', '/')
    .action(async (pattern: string, path: string, opts: Target) => {
      await callTool(opts, 'glob', { pattern, path })
    })
}
