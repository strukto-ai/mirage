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

API_BASE = "https://api.github.com"
API_VERSION = "2022-11-28"
SCOPE_WARN = 100
# GitHub's code search does not index a file at or over this size.
CODE_SEARCH_SIZE_LIMIT = 384 * 1024
# The largest page code search serves.
SEARCH_PAGE_SIZE = 100
SCOPE_ERROR = 5000
# A point request answering these did not see the parent directory: it is
# missing, the ref is gone, the repository is hidden (GitHub answers 404 for
# all three) or a component of the path is a file (422). None of them is an
# answer about the file, so the caller asks the whole tree instead, where a
# real absence is honest and a refusal raises.
DEFER_STATUSES = frozenset({404, 422})
