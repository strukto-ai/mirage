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

import { CHECK_WAIT_SECONDS } from '@struktoai/mirage-core/machine/constants'

// A handle built from config alone has no container: only the Durable
// Object that owns one can hand it over.
export const NO_CONTAINER =
  'cloudflare_container runs in the Durable Object that owns the container: ' +
  'build it with new ContainerMachine(name, config, ctx.container, start)'

// What a line the container stopped under says, after the provider's name.
export const STOPPED = 'the container stopped; the next line starts it again'

// Why a closing workspace does not reach a container that has stopped.
export const CLOSING = 'the container has stopped, and closing the workspace starts none'

// How often a container that was just started is asked the check line.
export const CHECK_POLL_SECONDS = 0.1

export const NOT_ANSWERING = `the container did not answer within ${String(CHECK_WAIT_SECONDS)}s of starting`
