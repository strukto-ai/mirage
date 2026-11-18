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

from collections.abc import Callable

from mirage.accessor.base import Accessor


class BinAccessor(Accessor):
    """Accessor over the workspace's command lookup for the /usr/bin view.

    Both answers are the calling session's, so a program its command
    trees close has no file either.

    Args:
        programs (Callable[[], list[str]]): every program name the
            session can run, sorted.
        note (Callable[[str], str | None]): the line one program's file
            says about it, None when the name runs as no program, which
            is what gives it a file.
    """

    def __init__(
        self,
        programs: Callable[[], list[str]],
        note: Callable[[str], str | None],
    ) -> None:
        self.programs = programs
        self.note = note
