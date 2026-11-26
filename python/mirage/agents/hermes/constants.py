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

BACKEND = "mirage"
SESSION_PREFIX = "hermes-"
SETTING = "config"
# Where the profile's ``ask`` rules send the line: an endpoint the host
# runs, the bearer token it wants and how long to wait before denying.
ASK_URL = "ask_url"
ASK_TOKEN = "ask_token"
ASK_TIMEOUT = "ask_timeout"
DEFAULT_ASK_TIMEOUT = 120.0
