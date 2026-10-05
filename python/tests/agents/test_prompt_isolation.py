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

import importlib
import sys

import pytest


class _BlockDeepagents:
    def find_spec(self, name, path=None, target=None):
        if name == "deepagents" or name.startswith("deepagents."):
            raise ModuleNotFoundError(f"blocked import of {name}")
        return None


def _evict_agents_and_deepagents(saved):
    for name in list(sys.modules):
        if (
            name == "deepagents"
            or name.startswith("deepagents.")
            or name == "mirage.agents"
            or name.startswith("mirage.agents.")
        ):
            saved[name] = sys.modules.pop(name)


@pytest.fixture
def deepagents_blocked():
    """Simulate an environment where `deepagents` is not installed.

    Yields:
        None: The fixture only manipulates import state; nothing is returned.
    """
    blocker = _BlockDeepagents()
    sys.meta_path.insert(0, blocker)
    saved = {}
    _evict_agents_and_deepagents(saved)
    try:
        yield
    finally:
        sys.meta_path.remove(blocker)
        for name in list(sys.modules):
            if (
                name == "deepagents"
                or name.startswith("deepagents.")
                or name == "mirage.agents"
                or name.startswith("mirage.agents.")
            ):
                del sys.modules[name]
        sys.modules.update(saved)


def test_pydantic_ai_package_imports_without_deepagents(deepagents_blocked):
    mod = importlib.import_module("mirage.agents.pydantic_ai")
    assert isinstance(mod.MIRAGE_SYSTEM_PROMPT, str)
    assert mod.MirageWorkspace is not None


def test_openai_agents_package_imports_without_deepagents(deepagents_blocked):
    mod = importlib.import_module("mirage.agents.openai_agents")
    assert isinstance(mod.MIRAGE_SYSTEM_PROMPT, str)
    assert mod.MirageRunner is not None


def test_langchain_full_import_fails_without_deepagents(deepagents_blocked):
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("mirage.agents.langchain")
