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


class CompletedOpError(Exception):
    """An error raised after the op already ran against the mount.

    The door reports a successful op to its caller through
    ``IOResult``; this is the same report for an op whose result was
    withheld. It carries the two fields ``IOResult`` carries, under the
    same names, so the ops facade records a withheld op exactly as it
    records a delivered one instead of guessing from the exception
    type.

    Inheriting this is how an exception declares "the backend already
    moved these bytes before I was raised". That is the opt-in: a door
    error that does not inherit it is one the facade will not record,
    which is right for a refusal that fired before any I/O.

    ``completed`` says the op ran. False is the default because a
    refusal at a pre gate suppresses the effect, not just the result,
    and must not be recorded at all.

    ``op_source`` names who served it when that was not the owning
    mount: "ram" for a warm cache hit or a synthetic namespace answer,
    neither of which touched the backend. None means the mount served
    it.

    ``op_bytes`` is how many bytes the backend moved before the result
    was withheld. The caller cannot recover it (the result is gone, and
    a read's count lives nowhere else), so without it a withheld read
    records zero and ``network_bytes`` under-reports real traffic. None
    means there is nothing to report beyond the op's own arguments.
    """

    completed = False
    op_source: str | None = None
    op_bytes: int | None = None
