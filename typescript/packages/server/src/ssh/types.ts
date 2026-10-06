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

import type { SSHConfig } from './config.ts'

/** A running SSH door, as the daemon holds it. */
export interface SSHListener {
  readonly port: number
  close(): Promise<void>
}

/** The daemon's SSH door: its config, and the listener once it is open. */
export interface SSHDoor {
  readonly config: SSHConfig
  listener: SSHListener | null
}
