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
import { tool } from '@openai/agents'
import { z } from 'zod'

function formatExecuteOutput(stdout: string, stderr: string, exitCode: number): string {
  const sections = [`exit code: ${String(exitCode)}`]
  if (stdout !== '') sections.push(`stdout:\n${stdout}`)
  if (stderr !== '') sections.push(`stderr:\n${stderr}`)
  return sections.join('\n')
}

async function executeOutput(ws: Workspace, command: string): Promise<string> {
  try {
    const result = await ws.execute(command)
    return formatExecuteOutput(result.stdoutText, result.stderrText, result.exitCode)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `Unable to execute command: ${message}`
  }
}

export function mirageExecuteTool(ws: Workspace) {
  return tool({
    name: 'execute',
    description:
      'Execute a shell command inside the Mirage workspace and return its stdout, stderr, and exit code.',
    parameters: z.object({
      command: z.string().describe('Shell command to execute inside the Mirage workspace.'),
    }),
    execute: async ({ command }) => executeOutput(ws, command),
  })
}
