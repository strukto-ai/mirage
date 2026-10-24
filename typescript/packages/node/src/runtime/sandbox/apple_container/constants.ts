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

export const APPLE_CONTAINER_HINT =
  "the apple_container runtime needs Apple's `container` on PATH " +
  '(`brew install container`, or the installer from ' +
  'https://github.com/apple/container/releases); it runs on Apple silicon ' +
  'with macOS 26 or later'

/**
 * `container inspect` reports RuntimeStatus's raw value: unknown,
 * stopped, running or stopping. Only "running" can take a line; a
 * container that was created but never started reports "stopped".
 */
export const RUNNING_STATE = 'running'

const STATE_HINTS: Record<string, string> = {
  stopped: 'it is stopped; start it with `container start {container}`',
  stopping: 'it is shutting down; once it stops, start it again with `container start {container}`',
}

/** Why a line has nowhere to run: its session maps to no container. */
export function noContainerHint(sessionId: string | null): string {
  return (
    `apple_container has no container for session ${sessionId ?? '(none)'}: ` +
    'list it under containers or set container'
  )
}

/** Why this container cannot take a line, named by its state. */
export function notRunningHint(container: string, state: string): string {
  const detail = STATE_HINTS[state]
  if (detail === undefined) return `container ${container} is not running (state: ${state})`
  return `container ${container} is not running: ${detail.replaceAll('{container}', container)}`
}
