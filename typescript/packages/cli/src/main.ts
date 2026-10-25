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
import { DaemonConfigError } from '@struktoai/mirage-server/daemon_config'
import { DaemonUnreachable } from './client.ts'
import { LoginError } from './credentials.ts'
import { registerConfigCommands } from './config.ts'
import { registerDaemonCommands } from './daemon.ts'
import { registerShellCommand } from './shell.ts'
import { registerToolCommands } from './tools.ts'
import { registerVfsCommands } from './vfs.ts'
import { registerJobCommands } from './job.ts'
import { registerLoginCommands } from './login.ts'
import { registerMcpCommand } from './mcp.ts'
import { registerRpcCommand } from './rpc.ts'
import { registerCodexExecCommand, registerSshProxyCommand } from './ssh.ts'
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
    .description('Mirage daemon CLI: manage workspaces and run shell lines.')
    .version(resolveVersion())
  registerWorkspaceCommands(program)
  registerSessionCommands(program)
  registerJobCommands(program)
  registerShellCommand(program)
  registerVfsCommands(program)
  registerToolCommands(program)
  registerMcpCommand(program)
  registerRpcCommand(program)
  registerSshProxyCommand(program)
  registerCodexExecCommand(program)
  registerLoginCommands(program)
  registerDaemonCommands(program)
  registerConfigCommands(program)
  return program
}

/**
 * Entry point that turns config errors into clean exit-2 lines and an
 * unreachable daemon or an ended login into a clean exit-1 line. `argv` is
 * the arguments after the program name.
 */
export async function main(argv: string[]): Promise<void> {
  try {
    await buildProgram().parseAsync(argv, { from: 'user' })
  } catch (err) {
    if (err instanceof DaemonConfigError) {
      console.error(err.message)
      process.exit(2)
    }
    if (err instanceof DaemonUnreachable || err instanceof LoginError) {
      console.error(err.message)
      process.exit(1)
    }
    console.error(err)
    process.exit(1)
  }
}
