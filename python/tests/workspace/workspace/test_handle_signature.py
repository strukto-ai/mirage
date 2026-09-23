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

import inspect

from mirage.workspace import Session, Workspace

# The one argument a `Session` answers for itself: it *is* the session, so
# naming one per call would be a second, contradictory source.
BOUND = "session_id"

# Arguments the executor's nested evals thread through and no embedder
# types. Exempt because they are marked ``Internal.`` in the docstring,
# which ``test_every_exemption_says_it_is_internal`` pins: adding a name
# here means documenting it as internal, not editing a list.
INTERNAL = ("routing_decision", "handed")


def _params(fn) -> list[inspect.Parameter]:
    return [
        p for name, p in inspect.signature(fn).parameters.items()
        if name != "self"
    ]


def test_the_handle_forwards_every_argument_the_workspace_takes():
    """``Session.shell`` is ``Workspace.shell`` with the session
    fixed, and the forwarding is hand-copied, so a parameter added to
    one has to reach the other. Without this, a new argument would be
    invisible from a `Session` and nothing would fail.
    """
    skip = (BOUND, *INTERNAL)
    wide = [p for p in _params(Workspace.shell) if p.name not in skip]
    bound = _params(Session.shell)
    assert [p.name for p in bound] == [p.name for p in wide]
    for got, want in zip(bound, wide):
        assert got.annotation == want.annotation, got.name
        assert got.default == want.default, got.name
        assert got.kind == want.kind, got.name


def test_the_handle_answers_for_the_session_itself():
    assert BOUND in inspect.signature(Workspace.shell).parameters
    assert BOUND not in inspect.signature(Session.shell).parameters


def test_every_exemption_says_it_is_internal():
    """An argument a `Session` may omit has to declare why in the
    docstring, so the allowlist cannot grow by edit alone.
    """
    doc = Workspace.shell.__doc__ or ""
    for name in INTERNAL:
        assert f"{name}: Internal." in doc, name
        assert name not in inspect.signature(Session.shell).parameters
