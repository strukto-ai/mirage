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

import asyncio

from mirage import MountMode, RAMResource, Workspace

ws = Workspace(
    {"/data/": RAMResource()},
    mode=MountMode.WRITE,
)

print("=== curl (returns the raw page body) ===")
result = asyncio.run(ws.execute("curl https://example.com"))
print(result.stdout)

print("\n=== curl a documentation page ===")
result = asyncio.run(
    ws.execute("curl https://docs.python.org/3/library/json.html"))
print(result.stdout)
