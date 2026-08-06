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

# git prints usage errors at tree levels with exit 129; leaf spec errors
# keep the GNU exit-2 machinery they already ride.
USAGE_EXIT = 129

# The environment variable carrying an install's config to a script CLI
# (JSON). Deliberately not MIRAGE_CONFIG: that one already names the
# workspace config file for the server and mcp entry points, and a
# script CLI that shells back into mirage must not find a config blob
# where a path belongs.
CLI_CONFIG_ENV = "MIRAGE_CLI_CONFIG"
