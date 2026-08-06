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

import { FlagView } from '../../../../spec/types.ts'
import { updatePage } from '../../../../../core/notion/pages.ts'
import { IOResult, type ByteSource } from '../../../../../io/types.ts'
import type { CommandFnResult } from '../../../../config.ts'
import type { CLIInvocation } from '../../../types.ts'
import { notionTransport, parseJsonFlag, usageError } from '../util.ts'

const ENC = new TextEncoder()

export async function edit(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  let body: Record<string, unknown>
  try {
    body = parseJsonFlag(fl.asStr('json'), '--json')
  } catch (err) {
    return usageError(err)
  }
  const page = await updatePage(notionTransport(inv.config), fl.asStr('page') ?? '', body)
  const out: ByteSource = ENC.encode(JSON.stringify(page))
  return [out, new IOResult()]
}
