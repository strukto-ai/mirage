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

import type { Workspace } from '@struktoai/mirage-core'

export const MIRAGE_SYSTEM_PROMPT = `Your filesystem is powered by Mirage — a virtual filesystem that mounts cloud storage, local files, and in-memory data as a unified file tree.

Capabilities beyond standard filesystem:
- head -n 5 on data files returns the first 5 rows
- grep works natively on CSV, JSON, Parquet — not just text
- Pipes work: cat data.csv | grep error | sort | uniq | wc -l
- head, tail, cut, wc, sort, uniq, tee, xargs are all available

You can write Python code and execute it. The workspace is pre-configured with your data sources mounted at their respective paths.

Use the execute tool for complex operations. Use read/write/edit for simple file operations.
`

export interface BuildSystemPromptOptions {
  workspace?: Workspace
  mountInfo?: Record<string, string>
  extraInstructions?: string
}

export function buildSystemPrompt(opts: BuildSystemPromptOptions = {}): string {
  const parts: string[] = [MIRAGE_SYSTEM_PROMPT]
  if (opts.workspace !== undefined) {
    parts.push('Mounted data sources:\n' + opts.workspace.filePrompt)
  } else if (opts.mountInfo !== undefined && Object.keys(opts.mountInfo).length > 0) {
    parts.push('\nMounted data sources:')
    for (const [prefix, description] of Object.entries(opts.mountInfo)) {
      parts.push(`- ${prefix} — ${description}`)
    }
    parts.push('')
  }
  if (opts.extraInstructions !== undefined && opts.extraInstructions.length > 0) {
    parts.push(opts.extraInstructions)
  }
  return parts.join('\n')
}
