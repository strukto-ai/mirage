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

import { Accessor } from './base.ts'

/**
 * Accessor over the workspace's command lookup for the /usr/bin view.
 * Both answers are the calling session's, so a program its command
 * trees close has no file either: `programs` is every program name the session
 * can run, sorted, and `note` is the line one program's file says about
 * it, null when the name runs as no program, which is what gives it a
 * file.
 */
export class BinAccessor extends Accessor {
  readonly programs: () => string[]
  readonly note: (name: string) => string | null

  constructor(programs: () => string[], note: (name: string) => string | null) {
    super()
    this.programs = programs
    this.note = note
  }
}
