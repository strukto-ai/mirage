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

export class Accessor {
  [key: string]: unknown

  /** Release what this accessor holds, when it holds anything. */
  close?(): Promise<void>
}

/** The accessor of a mount or CLI with no client of its own. */
export class NOOPAccessor extends Accessor {
  constructor(readonly config: unknown = null) {
    super()
  }
}
