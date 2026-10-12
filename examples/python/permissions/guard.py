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

import json
import os

# The reviewer's command program, named by workspace.yaml at
# pre_command. It reads its context as JSON, the same fields a coded
# policy reads, and prints its answer: nothing for no opinion, a deny to
# refuse. It runs on the runtime the document names, and open() reads
# through the workspace as the session.

ctx = json.loads(os.environ["MIRAGE_POLICY_CTX"])


def contents(path):
    try:
        return open(path).read()
    except OSError:
        return ""


if any("marker" in contents(path) for path in ctx["paths"]):
    reason = "marked files are not read by " + ctx["profile"]
    print(json.dumps({"kind": "deny", "reason": reason}))
