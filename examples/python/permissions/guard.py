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

# The reviewer's policy program, named by workspace.yaml. Any of the
# three admission hooks may be defined; each is handed the door's facts
# as ctx and answers with return: None for no opinion, {"deny": reason}
# to refuse. It runs on the engine the document names, and open() reads
# through the workspace.


def pre_command(ctx):
    for path in ctx["command"]["paths"]:
        if "marker" in contents(path):
            return {"deny": "marked files are not read by " + ctx["profile"]}
    return None


def pre_ops(ctx):
    op = ctx["op"]
    if op["write"] and op["path"].startswith("/scratch/cold/"):
        return {"deny": "the cold store is frozen"}
    return None


def pre_session(ctx):
    if ctx["write"]["key"].startswith("AWS_"):
        return {"deny": "credentials are set by the operator"}
    return None


def contents(path):
    try:
        return open(path).read()
    except OSError:
        return ""
