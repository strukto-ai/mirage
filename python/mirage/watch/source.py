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

from dataclasses import dataclass

from mirage.watch.queue.base import WatchQueue


@dataclass(slots=True)
class Subscriber:
    """One active watch iterator: its queue and match scopes.

    Args:
        queue (WatchQueue): Delivery queue owned by this subscriber.
        roots (tuple[str, ...]): Watch roots the subscriber asked for;
            each is a virtual path that may carry glob segments
            (``/nc/data/*.txt``); the root's shape defines the depth.
    """
    queue: WatchQueue
    roots: tuple[str, ...]
