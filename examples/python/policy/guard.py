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

# The reviewer's command program, named by workspace.yaml at
# pre_command. Its pre_command takes the same fields a coded policy
# reads and returns its answer: None for no opinion, a deny to refuse.
# It runs on the runtime the document names, and open() reads through
# the workspace as the session.


def contents(path):
    try:
        return open(path).read()
    except OSError:
        return ""


def pre_command(ctx):
    if any("marker" in contents(path) for path in ctx["paths"]):
        reason = "marked files are not read by " + ctx["profile"]
        return {"kind": "deny", "reason": reason}
