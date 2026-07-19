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

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { registerConfigCommands } from './config.ts'
import { registerDaemonCommands } from './daemon.ts'
import { registerExecuteCommand } from './execute.ts'
import { registerJobCommands } from './job.ts'
import { registerMcpCommand } from './mcp.ts'
import { registerProvisionCommand } from './provision.ts'
import { registerSessionCommands } from './session.ts'
import { registerWorkspaceCommands } from './workspace.ts'

function resolveVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string
        version?: string
      }
      if (pkg.name === '@struktoai/mirage-cli' && pkg.version) return pkg.version
    } catch {
      // package.json absent at this level: keep walking up to the package root
    }
    dir = dirname(dir)
  }
  return '0.0.0'
}

export function buildProgram(): Command {
  const program = new Command()
  program
    .name('mirage')
    .description('Mirage daemon CLI: manage workspaces and execute commands.')
    .version(resolveVersion())
  registerWorkspaceCommands(program)
  registerSessionCommands(program)
  registerJobCommands(program)
  registerExecuteCommand(program)
  registerMcpCommand(program)
  registerProvisionCommand(program)
  registerDaemonCommands(program)
  registerConfigCommands(program)
  return program
}
