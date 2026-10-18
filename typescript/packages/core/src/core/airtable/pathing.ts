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

import { makeIdName } from '../../utils/naming.ts'
import { VIEW_SUFFIX } from './constants.ts'

function idOf(entity: Record<string, unknown>): string {
  return String(entity.id)
}

function label(entity: Record<string, unknown>): string {
  const name = entity.name
  return typeof name === 'string' && name !== '' ? name : idOf(entity)
}

/** `<Base_Name>__app...`, the one spelling of a base directory. */
export function baseDirname(base: Record<string, unknown>): string {
  return makeIdName(label(base), idOf(base))
}

/** `<Table_Name>__tbl...`, the one spelling of a table directory. */
export function tableDirname(table: Record<string, unknown>): string {
  return makeIdName(label(table), idOf(table))
}

/** `<View_Name>__viw....jsonl`, the one spelling of a view file. */
export function viewFilename(view: Record<string, unknown>): string {
  return makeIdName(label(view), idOf(view), false, VIEW_SUFFIX)
}
