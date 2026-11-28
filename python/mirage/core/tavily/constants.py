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

DEFAULT_API_BASE_URL = "https://api.tavily.com"
CLIENT_SOURCE = "mirage"
KEYLESS_CLIENT_SOURCE = "mirage-keyless"
# The longest call tvly 1.0.2 waits on, crawl and map, whose answer
# arrives whole only after the server finishes walking. A connection
# that may sit this long without a byte needs a pool that waits as long.
DEFAULT_TIMEOUT = 150.0
SEARCH_TIMEOUT = 60.0
SEARCH_MAX_TIMEOUT = 120.0
EXTRACT_TIMEOUT = 30.0
SITE_TIMEOUT = 150.0
RESEARCH_GET_TIMEOUT = 60.0
