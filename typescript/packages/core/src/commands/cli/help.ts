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

import { flagRows } from '../spec/help.ts'
import type { CLISpec } from './types.ts'

/**
 * Render a group node's help: usage line, commands, own flags. Follows
 * git's shape (`git` with no verb prints a usage block naming the
 * subcommands); the same text serves `--help` (stdout, exit 0) and the
 * bare-group refusal (stdout, exit 1, matching git). `name` is the full
 * display path as typed ("gws gmail"); the head word is the installed
 * name, so a renamed install renders its own spelling.
 */
export function renderGroupHelp(name: string, node: CLISpec): string {
  const lines: string[] = []
  const usageBits = [`usage: ${name}`]
  if (node.options.length > 0) usageBits.push('[<options>]')
  usageBits.push('<command> [<args>]')
  lines.push(usageBits.join(' '))
  if (node.description !== null && node.description !== '') {
    lines.push('')
    lines.push(node.description)
  }
  lines.push('')
  lines.push('Commands:')
  const width = Math.max(...node.subcommands.map((child) => child.name.length))
  const children = [...node.subcommands].sort((a, b) => (a.name < b.name ? -1 : 1))
  for (const child of children) {
    const desc = (child.description ?? '').split('\n')[0] ?? ''
    lines.push(desc === '' ? `  ${child.name}` : `  ${child.name.padEnd(width, ' ')}  ${desc}`)
  }
  if (node.options.length > 0) {
    lines.push('')
    lines.push('Flags:')
    const rows = flagRows(node)
    const flagWidth = Math.max(...rows.map(([flag]) => flag.length))
    for (const [flag, desc] of rows) {
      lines.push(desc === '' ? `  ${flag}` : `  ${flag.padEnd(flagWidth, ' ')}  ${desc}`)
    }
  }
  return `${lines.join('\n')}\n`
}
