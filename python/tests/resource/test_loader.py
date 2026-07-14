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

import pytest

from mirage.resource.loader import load_backend_class
from mirage.types import PathSpec

_ps = PathSpec.from_str_path


def _cat_sync(backend, path):

    async def _collect():
        return b"".join([c async for c in backend.read_stream(path)])

    return asyncio.run(_collect())


def test_load_from_module():
    cls = load_backend_class("mirage.resource.ram.ram:RAMResource")
    from mirage.resource.ram import RAMResource
    assert cls is RAMResource


def test_load_from_script_file(tmp_path):
    script = tmp_path / "custom_backend.py"
    script.write_text("from mirage.resource.ram import RAMResource\n"
                      "class CustomBackend(RAMResource):\n"
                      "    pass\n")
    cls = load_backend_class(f"{script}:CustomBackend")
    assert cls.__name__ == "CustomBackend"
    instance = cls()
    asyncio.run(instance.write(_ps("/test.txt"), data=b"hello"))
    assert _cat_sync(instance, _ps("/test.txt")) == b"hello"


def test_load_invalid_spec_no_colon():
    with pytest.raises(ValueError, match="invalid backend spec"):
        load_backend_class("mirage.resource.ram")


def test_load_missing_file():
    with pytest.raises(ValueError, match="cannot load script"):
        load_backend_class("/nonexistent/path.py:Cls")


def test_load_missing_class():
    with pytest.raises(ValueError, match="not found"):
        load_backend_class("mirage.resource.ram.ram:DoesNotExist")
