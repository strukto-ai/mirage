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

from mirage.accessor.base import Accessor
from mirage.observe.observer import Observer


class HistoryAccessor(Accessor):
    """Accessor over the hidden recorder for the /.bash_history view.

    Args:
        observer (Observer): The workspace's hidden recorder.
        made (str): when the view was made, its time before any command.
    """

    def __init__(self, observer: Observer, made: str) -> None:
        self.observer = observer
        self.made = made
