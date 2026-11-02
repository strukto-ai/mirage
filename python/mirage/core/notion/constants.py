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

DEFAULT_API_BASE_URL = "https://api.notion.com/v1"
# 2025-09-03 is the generation that split databases into data sources: a
# database became a container of data sources and the column schema moved to
# the data source, so `/databases/{id}` no longer answers with `properties` and
# `/search` rejects `filter.value = "database"`.
API_VERSION = "2025-09-03"
MAX_PAGE_SIZE = 100
