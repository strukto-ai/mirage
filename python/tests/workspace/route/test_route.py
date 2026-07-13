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

from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace
from mirage.workspace.route import SHELL_CONSUMERS, Consumer, route
from mirage.workspace.session import Session


def _fixture() -> tuple[Session, Workspace]:
    ws = Workspace(resources={"/ram": (RAMResource(), MountMode.WRITE)})
    return Session(session_id="t"), ws


def test_builtins_route_session():
    session, ws = _fixture()
    for name in ("cd", "echo", "export", "history", "test", "xargs"):
        assert route(name, session, ws._registry) is Consumer.SESSION


def test_unsupported_builtins_route_session():
    session, ws = _fixture()
    assert route("exec", session, ws._registry) is Consumer.SESSION


def test_namespace_commands():
    session, ws = _fixture()
    assert route("ln", session, ws._registry) is Consumer.NAMESPACE
    assert route("readlink", session, ws._registry) is Consumer.NAMESPACE


def test_function_routes_function():
    session, ws = _fixture()
    session.functions["greet"] = []
    assert route("greet", session, ws._registry) is Consumer.FUNCTION


def test_builtin_shadows_function():
    session, ws = _fixture()
    session.functions["echo"] = []
    assert route("echo", session, ws._registry) is Consumer.SESSION


def test_function_shadows_mount_command():
    session, ws = _fixture()
    session.functions["cat"] = []
    assert route("cat", session, ws._registry) is Consumer.FUNCTION


def test_mount_command_routes_mount():
    session, ws = _fixture()
    assert route("cat", session, ws._registry) is Consumer.MOUNT
    assert route("grep", session, ws._registry) is Consumer.MOUNT


def test_unregistered_name_routes_unknown():
    session, ws = _fixture()
    assert route("nosuchcmd", session, ws._registry) is Consumer.UNKNOWN


def test_shell_consumers_resolve_globs():
    assert Consumer.SESSION in SHELL_CONSUMERS
    assert Consumer.NAMESPACE in SHELL_CONSUMERS
    assert Consumer.FUNCTION in SHELL_CONSUMERS
    assert Consumer.MOUNT not in SHELL_CONSUMERS
    assert Consumer.UNKNOWN not in SHELL_CONSUMERS
