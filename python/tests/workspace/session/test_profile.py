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

from mirage.resource.ram import RAMResource
from mirage.types import HiddenPaths, HiddenVars, MountMode
from mirage.workspace import Workspace
from mirage.workspace.session import SessionProfile


def _ws() -> Workspace:
    a = RAMResource()
    a._store.files["/x.txt"] = b"public\n"
    a._store.files["/secrets/token.txt"] = b"s3cr3t\n"
    a._store.dirs.add("/secrets")
    b = RAMResource()
    b._store.files["/y.txt"] = b"other\n"
    return Workspace({
        "/a": (a, MountMode.WRITE),
        "/b": (b, MountMode.WRITE)
    },
                     mode=MountMode.WRITE)


ANALYST = SessionProfile(mounts={"/a": "write"},
                         hidden_paths=HiddenPaths(paths=("/a/secrets", )),
                         hidden_vars=HiddenVars(names=("SLACK_TOKEN", )),
                         env={"ROLE": "analyst"})


def test_profile_applies_every_narrowing_field():
    ws = _ws()
    sess = ws.create_session("agent", profile=ANALYST)
    assert sess.mount_modes is not None
    assert sess.mount_modes["/a"] == MountMode.WRITE
    assert "/b" not in sess.mount_modes
    assert sess.hidden_paths == ANALYST.hidden_paths
    assert sess.hidden_vars == ANALYST.hidden_vars
    assert sess.env["ROLE"] == "analyst"


def test_one_profile_serves_many_sessions():
    # A profile is a role, not a session: frozen, so two agents share
    # one object and neither can bend the other's view.
    ws = _ws()
    s1 = ws.create_session("agent1", profile=ANALYST)
    s2 = ws.create_session("agent2", profile=ANALYST)
    assert s1.hidden_paths is s2.hidden_paths
    s1.env["ROLE"] = "changed"
    assert s2.env["ROLE"] == "analyst"


def test_explicit_mounts_override_the_profile():
    ws = _ws()
    sess = ws.create_session("agent", mounts={"/b": "read"}, profile=ANALYST)
    assert sess.mount_modes is not None
    assert "/b" in sess.mount_modes
    assert "/a" not in sess.mount_modes
    assert sess.hidden_paths == ANALYST.hidden_paths


def test_profiled_session_is_narrowed_end_to_end():
    ws = _ws()
    ws.create_session("agent", profile=ANALYST)

    async def run():
        listing = await ws.execute("ls /a", session_id="agent")
        denied = await ws.execute("cat /a/secrets/token.txt",
                                  session_id="agent")
        role = await ws.execute('echo "$ROLE"', session_id="agent")
        return (await listing.stdout_str(), denied, await role.stdout_str())

    listing_out, denied, role_out = asyncio.run(run())
    assert "x.txt" in listing_out
    assert "secrets" not in listing_out
    assert denied.exit_code != 0
    assert role_out == "analyst\n"
