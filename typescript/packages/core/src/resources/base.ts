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

import type {
  Entry,
  EntryInput,
  EntryKind,
  Policy,
  RevealedEntry,
  Template,
  TemplateInput,
} from './types.ts'

/**
 * One scope's saved configs: vfs, cli, runtime and store entries, policies
 * and templates. Every backend answers the same way: lists sort by name, an
 * entry's sealed values leave only through `revealEntry`, deleting an entry
 * wipes them, and a deleted template can be restored. A missing name raises
 * `ResourceError('not_found')`.
 */
export interface ResourceStore {
  readonly scope: string

  listEntries(kind: EntryKind): Promise<Entry[]>
  getEntry(kind: EntryKind, name: string): Promise<Entry>
  /** Create or replace an entry. Its name is unique across the four entry kinds. */
  putEntry(kind: EntryKind, input: EntryInput): Promise<Entry>
  deleteEntry(kind: EntryKind, name: string): Promise<void>
  revealEntry(kind: EntryKind, name: string): Promise<RevealedEntry>

  listPolicies(): Promise<Policy[]>
  getPolicy(name: string): Promise<Policy>
  putPolicy(policy: Policy): Promise<Policy>
  deletePolicy(name: string): Promise<void>

  listTemplates(): Promise<Template[]>
  getTemplate(name: string): Promise<Template>
  /** Save a new template; a conflict when a live one has the name. */
  createTemplate(template: TemplateInput): Promise<Template>
  putTemplate(template: TemplateInput): Promise<Template>
  deleteTemplate(name: string): Promise<void>
  /** Bring back the template last deleted under `name`; a conflict while a live one has it. */
  restoreTemplate(name: string): Promise<Template>
}
