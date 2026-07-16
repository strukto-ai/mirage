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

from mirage.accessor.history import HistoryAccessor
from mirage.commands.builtin.history import COMMANDS
from mirage.ops.history import OPS
from mirage.resource.base import BaseResource

HISTORY_PREFIX = "/.bash_history"


class HistoryViewResource(BaseResource):
    """Read-only view resource backing the /.bash_history mount.

    Renders GNU views from the workspace's hidden recorder on every
    read; holds no storage of its own.

    Args:
        observer (Observer): The workspace's hidden recorder.
    """
    accessor: HistoryAccessor

    name = "history"

    def __init__(self, observer) -> None:
        super().__init__()
        self.observer = observer
        self.accessor = HistoryAccessor(observer)
        for fn in COMMANDS:
            self.register(fn)
        for fn in OPS:
            self.register_op(fn)
