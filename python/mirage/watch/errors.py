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


class QueueOverflowError(Exception):
    """Raised to a watch consumer when its queue overflowed under
    ``OverflowPolicy.ERROR``.

    The queue is cleared when this is raised; the consumer should
    re-inventory the watch root (``find``) before resuming.
    """


class QueueClosed(Exception):
    """Terminal signal from ``WatchQueue.pop`` after ``close``.

    The watch iterator translates it into normal iterator exhaustion;
    consumers never see it.
    """
