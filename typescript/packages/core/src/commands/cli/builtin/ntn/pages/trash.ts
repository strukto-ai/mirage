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
import { IOResult } from '../../../../../io/types.ts'
import type { CommandFnResult } from '../../../../config.ts'
import type { CLIInvocation } from '../../../types.ts'
import { firstText, notionTransport, usageError } from '../util.ts'

const ENC = new TextEncoder()
const NEEDS_YES =
  'error: Cannot confirm in a non-interactive environment.\n' +
  '  hint: Use --yes to skip the confirmation prompt.\n'

export async function trash(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  let pageId: string
  try {
    pageId = firstText(inv.texts, 'page id')
  } catch (err) {
    return usageError(err)
  }
  // A mirage session has no terminal, so this is the branch the upstream CLI
  // takes when it cannot prompt: refuse and say how.
  if (!fl.asBool('yes')) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(NEEDS_YES) })]
  }
  await updatePage(notionTransport(inv.config, inv.flags), pageId, { in_trash: true })
  return [null, new IOResult({ stderr: ENC.encode('✔ Page trashed\n') })]
}
