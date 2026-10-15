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

from mirage.accessor.slack import SlackAccessor
from mirage.core.hierarchy.stat import StatHook, make_stat
from mirage.core.slack.scope import detect_scope
from mirage.core.time_range import day_stat, guard_day

# A chat.jsonl, a files directory or a blob is what its day's listing
# names, which no day outside the mount's scope has; only a day itself
# exists beyond what is listed.
_day: StatHook[SlackAccessor] = day_stat(guard_day)
stat = make_stat(detect_scope, overrides={"day": _day})
