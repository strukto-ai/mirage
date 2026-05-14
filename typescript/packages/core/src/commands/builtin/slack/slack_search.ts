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

import type { SlackAccessor } from '../../../accessor/slack.ts'
import { searchMessages } from '../../../core/slack/search.ts'
import { IOResult } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { CommandSpec, OperandKind, Option } from '../../spec/types.ts'

const SPEC = new CommandSpec({
  options: [
    new Option({
      long: '--query',
      valueKind: OperandKind.TEXT,
      description: "Slack search query (supports operators like 'from:@user', 'in:#channel')",
    }),
    new Option({
      long: '--count',
      valueKind: OperandKind.TEXT,
      description: 'Results per page (1-100, default 20)',
    }),
    new Option({
      long: '--page',
      valueKind: OperandKind.TEXT,
      description: '1-based page number (default 1)',
    }),
  ],
})

function parseIntFlag(
  raw: string | boolean | undefined,
  name: string,
  fallback: number,
  lo: number,
  hi: number | null,
): number {
  if (raw === undefined || raw === '' || typeof raw !== 'string') return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be an integer`)
  if (parsed < lo) throw new Error(`--${name} must be >= ${String(lo)}`)
  if (hi !== null && parsed > hi) throw new Error(`--${name} must be <= ${String(hi)}`)
  return parsed
}

async function slackSearchCommand(
  accessor: SlackAccessor,
  _paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const query = opts.flags.query
  if (typeof query !== 'string' || query === '') {
    throw new Error('--query is required')
  }
  const count = parseIntFlag(opts.flags.count, 'count', 20, 1, 100)
  const page = parseIntFlag(opts.flags.page, 'page', 1, 1, null)
  const result = await searchMessages(accessor, query, count, page)
  return [result, new IOResult()]
}

export const SLACK_SEARCH = command({
  name: 'slack-search',
  resource: ResourceName.SLACK,
  spec: SPEC,
  fn: slackSearchCommand,
})
