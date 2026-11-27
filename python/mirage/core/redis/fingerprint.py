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


def token_of(modified: str | None) -> str | None:
    """A file's fingerprint: the time its last write landed at, to the
    nanosecond, as the store keeps it; None for a file no write dated.

    Every write lands past the time its client gave the write before
    (``RedisStore.stamped``), so a rewrite always moves it, a same-size
    one in the same instant included.

    Args:
        modified (str | None): the file's stored modified time.
    """
    return modified
