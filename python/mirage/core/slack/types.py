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

from typing import Any, NotRequired, TypedDict


class SlackChannel(TypedDict):
    id: str
    name: NotRequired[str]
    user: NotRequired[str]
    is_archived: NotRequired[bool]
    created: NotRequired[int]


class SlackMessage(TypedDict):
    ts: str
    user: NotRequired[str]
    text: NotRequired[str]
    thread_ts: NotRequired[str]
    files: NotRequired[list[dict[str, Any]]]


class SlackUser(TypedDict):
    id: NotRequired[str]
    name: NotRequired[str]
    real_name: NotRequired[str]
    deleted: NotRequired[bool]
    is_bot: NotRequired[bool]
    profile: NotRequired[dict[str, str]]
