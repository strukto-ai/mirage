#!/usr/bin/env node
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

import { DaemonConfigError } from '@struktoai/mirage-server'
import { buildProgram } from '../main.ts'

const ALIASES: Record<string, string> = {
  '--workspace_id': '--workspace',
  '--session_id': '--session',
}

function rewriteArgv(argv: string[]): string[] {
  return argv.map((arg) => {
    for (const [from, to] of Object.entries(ALIASES)) {
      if (arg === from) return to
      if (arg.startsWith(from + '=')) return to + arg.slice(from.length)
    }
    return arg
  })
}

buildProgram()
  .parseAsync(rewriteArgv(process.argv))
  .catch((err: unknown) => {
    if (err instanceof DaemonConfigError) {
      console.error(err.message)
      process.exit(2)
    }
    console.error(err)
    process.exit(1)
  })
