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

import type { PauseAction } from '@struktoai/mirage-core/machine/types'

export const DOCKER_HINT =
  'the docker machine needs `docker` on PATH (Docker Desktop, colima, or a podman alias)'

/**
 * `docker inspect` reports State.Status: created, running, paused,
 * restarting, removing, exited or dead. Only "running" takes a line; a
 * "paused" container is unpaused first.
 */
export const RUNNING_STATE = 'running'
export const PAUSED_STATE = 'paused'

/** What `onPause` takes for a container: freeze its processes, which frees its CPU and keeps its memory. */
export const ON_PAUSE: readonly PauseAction[] = ['pause']

/** What `docker pause` says of a container already gone. */
export const CONTAINER_GONE = 'No such container'
