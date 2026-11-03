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

# Seconds to connect, send a request or wait for a pooled connection.
CONNECT_TIMEOUT = 60.0
# Seconds one MCP request may wait for its answer.
TIMEOUT = 300.0
# Pages of tools read before the listing is refused.
MAX_PAGES = 64
# Bytes one MCP reply may carry, and a whole tool listing across its pages.
MAX_REPLY = 16 * 1024 * 1024
# Tools one MCP server may list.
MAX_TOOLS = 1024
REPLY_TOO_LARGE = f"MCP server reply exceeds {MAX_REPLY} bytes"
# Content encodings a reply may arrive in; it is inflated before it counts.
INFLATED = frozenset({"gzip", "x-gzip", "deflate"})
# Bytes inflated from a reply at a time.
INFLATE_CHUNK = 64 * 1024
REPLY_ENCODING = "MCP server reply uses an encoding the client cannot read"
