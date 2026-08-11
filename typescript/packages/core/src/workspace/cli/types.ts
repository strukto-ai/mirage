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

import type { CLISpec } from '../../commands/cli/types.ts'

/**
 * One installed CLI: a head word bound to a program tree.
 *
 * The installed name is the dispatch key, not the spec's own name: two
 * installations of the same spec under different names (two accounts)
 * are two independent entries whose help and errors attribute to their
 * installed head. `config` is the installation's validated configModel
 * output, handed to every leaf fn; null when the spec declares none.
 */
export interface CLIInstall {
  readonly name: string
  readonly spec: CLISpec
  readonly config: unknown
}
