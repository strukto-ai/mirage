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


from mirage.context import bind_caller, current_caller
from mirage.workspace.types import StatusWriter


def set_line_writer(writer: StatusWriter) -> None:
    """Mark the running task as this line's.

    Set by ``execute_line``, which is the line's whole task, so every
    statement and every nested evaluation the line spawns inherits it
    and no other line can see it.

    Args:
        writer (StatusWriter): the line's identity.
    """
    bind_caller(current_caller().changed({"line_writer": writer}))


def line_status_writer() -> StatusWriter | None:
    """The identity of the line running on this task, if any.

    ``None`` outside a line (a background job, a test driving a handler
    directly): nothing is restoring there.
    """
    return current_caller().line_writer
