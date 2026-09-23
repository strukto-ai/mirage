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

import { gnuDirname } from '@struktoai/mirage-core/utils/path'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { applyDiff } from '@openai/agents'
import type { ApplyPatchOperation, ApplyPatchResult, Editor } from '@openai/agents'

async function ensureParent(ws: Workspace, path: string): Promise<void> {
  const parent = gnuDirname(path)
  if (parent === '/' || parent === '' || parent === '.') return
  if (await ws.vfs.exists(parent)) return
  await ensureParent(ws, parent)
  try {
    await ws.vfs.mkdir(parent)
  } catch (err) {
    // Tolerate mkdir race: another caller may have created the dir between exists() and mkdir().
    if (!(await ws.vfs.exists(parent))) throw err
  }
}

export class MirageEditor implements Editor {
  constructor(private readonly ws: Workspace) {}

  async createFile(
    op: Extract<ApplyPatchOperation, { type: 'create_file' }>,
  ): Promise<ApplyPatchResult> {
    await ensureParent(this.ws, op.path)
    const content = applyDiff('', op.diff, 'create')
    await this.ws.vfs.writeFile(op.path, content)
    return { status: 'completed' }
  }

  async updateFile(
    op: Extract<ApplyPatchOperation, { type: 'update_file' }>,
  ): Promise<ApplyPatchResult> {
    let current: string
    try {
      current = await this.ws.vfs.readFileText(op.path)
    } catch {
      return { status: 'failed', output: `File not found: ${op.path}` }
    }
    const next = applyDiff(current, op.diff)
    await this.ws.vfs.writeFile(op.path, next)
    return { status: 'completed' }
  }

  async deleteFile(
    op: Extract<ApplyPatchOperation, { type: 'delete_file' }>,
  ): Promise<ApplyPatchResult> {
    if (!(await this.ws.vfs.exists(op.path))) {
      return { status: 'failed', output: `File not found: ${op.path}` }
    }
    await this.ws.vfs.unlink(op.path)
    return { status: 'completed' }
  }
}
