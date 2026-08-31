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

import { Router } from '../kit/typescript/index.ts'
import type { C } from './config.ts'

// ONE per-run write queue for every mail arm. The queue lives on the Router
// INSTANCE, so a `new Router([])` per module was three independent queues:
// an IMAP APPEND and an SMTP delivery into the same run could both read the
// same `uidNext` and insert the same UID. IMAP and SMTP share this one.
// The HTTP arm's /reset still serializes on the kit's own router queue,
// which is fine for the one thing that arm does: a reset issued beside an
// in-flight IMAP write is a harness contradicting itself, not a race any
// queue could repair.
export const queue = new Router<C>([])
