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
import re

CONTEXTS_DIR = "contexts"
CURRENT_FILE = "current_context"
LOGINS_DIR = "logins"
LOCAL = "local"
HOSTED = "strukto"
HOSTED_URL = "https://api.strukto.ai"
DEFAULT_PORT = 8765
CONTEXT_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,62}$")
