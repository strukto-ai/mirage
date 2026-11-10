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
import { registerApiCommand } from './api.ts'
import { DaemonUnreachable } from './client.ts'
import { ContextError, LoginError } from './credentials.ts'
import { ENV_CONTEXT } from './env.ts'
import { registerDaemonCommands } from './daemon.ts'
import { registerShellCommand } from './shell.ts'
import { registerToolCommands } from './tools.ts'
import { registerVfsCommands } from './vfs.ts'
import { registerConnectionCommands } from './connections.ts'
import { registerContextCommands, registerLoginCommands } from './login.ts'
import { registerMcpCommand } from './mcp.ts'
import { registerPolicyCommands } from './policy.ts'
import { registerRpcCommand } from './rpc.ts'
import { registerCodexExecCommand, registerSshProxyCommand } from './ssh.ts'
import { registerSessionCommands } from './session.ts'
import { registerTemplateCommands } from './template.ts'
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

/**
 * The `mirage` program. A usage error exits 2, as the Python CLI's does,
 * where commander would exit 1; help and the version still exit 0. Every
 * subcommand inherits that.
 */
export function buildProgram(): Command {
  const program = new Command()
  program
    .name('mirage')
    .description('Mirage daemon CLI: manage workspaces and run shell lines.')
    .exitOverride((err) => process.exit(err.exitCode === 1 ? 2 : err.exitCode))
    .version(resolveVersion())
    .option(
      '--context <name>',
      'Run this one command in another context; $MIRAGE_CONTEXT does the same',
    )
    .hook('preAction', (root) => {
      const context = root.opts<{ context?: string }>().context
      if (context !== undefined && context !== '') process.env[ENV_CONTEXT] = context
    })
  const ws = registerWorkspaceCommands(program)
  registerShellCommand(ws)
  registerVfsCommands(ws)
  registerSessionCommands(ws)
  registerToolCommands(ws)
  registerShellCommand(program)
  registerPolicyCommands(program)
  registerConnectionCommands(program)
  registerApiCommand(program)
  registerMcpCommand(program)
  registerRpcCommand(program)
  registerSshProxyCommand(program)
  registerCodexExecCommand(program)
  registerLoginCommands(program)
  registerDaemonCommands(program)
  registerContextCommands(program)
  registerTemplateCommands(program)
  return program
}

/**
 * Entry point that turns config and context errors into clean exit-2 lines and an
 * unreachable daemon or an ended login into a clean exit-1 line. `argv` is
 * the arguments after the program name.
 */
export async function main(argv: string[]): Promise<void> {
  try {
    await buildProgram().parseAsync(argv, { from: 'user' })
  } catch (err) {
    if (err instanceof DaemonConfigError || err instanceof ContextError) {
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
