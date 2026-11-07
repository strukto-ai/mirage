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

import { CONTINUE_SIGNALS, SIGSTOP, STOP_SIGNALS } from '../../../../shell/constants.ts'

// Signals a running process takes and goes on: those whose default is to
// ignore them, and the terminal stops a non-interactive bash's asynchronous
// commands ignore; kill answers for them as for the probe (0). Mirrors
// Python's KEPT_SIGNALS.
export const KEPT_SIGNALS: ReadonlySet<number> = new Set(
  [...CONTINUE_SIGNALS, ...STOP_SIGNALS].filter((signal) => signal !== SIGSTOP),
)
