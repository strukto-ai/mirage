# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

APPLE_CONTAINER_HINT = (
    "the apple_container runtime needs Apple's `container` on PATH "
    "(`brew install container`, or the installer from "
    "https://github.com/apple/container/releases); it runs on Apple "
    "silicon with macOS 26 or later"
)

# `container inspect` reports RuntimeStatus's raw value: unknown,
# stopped, running or stopping. Only "running" can take a line; a
# container that was created but never started reports "stopped".
RUNNING_STATE = "running"

STATE_HINTS: dict[str, str] = {
    "stopped": "it is stopped; start it with `container start {container}`",
    "stopping": (
        "it is shutting down; once it stops, start it again with "
        "`container start {container}`"
    ),
}


def no_container_hint(session_id: str | None) -> str:
    """Why a line has nowhere to run: its session maps to no container.

    Args:
        session_id (str | None): the line's session, None outside one.
    """
    session = session_id if session_id is not None else "(none)"
    return (
        f"apple_container has no container for session {session}: "
        "list it under containers or set container"
    )


def not_running_hint(container: str, state: str) -> str:
    """Why this container cannot take a line, named by its state.

    Args:
        container (str): the configured container id.
        state (str): the state string `container inspect` reported.
    """
    detail = STATE_HINTS.get(state)
    if detail is None:
        return f"container {container} is not running (state: {state})"
    reason = detail.format(container=container)
    return f"container {container} is not running: {reason}"
