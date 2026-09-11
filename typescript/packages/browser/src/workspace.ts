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

import type { Resource } from '@struktoai/mirage-core/resource/base'
import { createShellParser } from '@struktoai/mirage-core/shell/parse'
import type { ShellParser } from '@struktoai/mirage-core/shell/parse'
import { Workspace as CoreWorkspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import type { WorkspaceOptions } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { savedResourceBuild } from '@struktoai/mirage-core/workspace/snapshot/state'
import type { MountSnapshot } from '@struktoai/mirage-core/workspace/snapshot/types'
import { buildResource, knownResources } from './resource/registry.ts'
import { ENGINE_WASM_BASE64, GRAMMAR_WASM_BASE64 } from './generated/wasm.ts'

let cachedParser: Promise<ShellParser> | null = null

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const len = bin.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function loadShellParser(): Promise<ShellParser> {
  if (cachedParser !== null) return cachedParser
  cachedParser = createShellParser({
    engineWasm: base64ToBytes(ENGINE_WASM_BASE64),
    grammarWasm: base64ToBytes(GRAMMAR_WASM_BASE64),
  })
  return cachedParser
}

function randomSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return `session-${hex}`
}

export class Workspace extends CoreWorkspace {
  /** A saved mount rebuilds through this package's resource registry. */
  protected static override async buildSavedResource(
    entry: MountSnapshot,
  ): Promise<Resource | null> {
    const build = savedResourceBuild(entry, (name) => knownResources().includes(name))
    return build === null ? null : buildResource(build.name, build.config)
  }

  constructor(resources: Record<string, Resource>, options: WorkspaceOptions = {}) {
    super(resources, {
      ...options,
      sessionId: options.sessionId ?? randomSessionId(),
      shellParserFactory: options.shellParserFactory ?? loadShellParser,
    })
  }
}
