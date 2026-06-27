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

import re
from pathlib import Path

import mirage

_ROOT = Path(mirage.__file__).resolve().parent
_RESOURCE_DIR = _ROOT / "resource"
_BUILTIN_DIR = _ROOT / "commands" / "builtin"

# A command module reads file content when it imports a raw backend reader
# from the backend's read/stream module.
_READER_IMPORT = re.compile(
    r"from mirage\.core\.\w+\.read import .*\bread\b|"
    r"from mirage\.core\.\w+\.stream import .*(read_stream|range_read)|"
    r"read_bytes_with_index")
# It is cache-aware iff it routes that reader through the shared wrappers.
_CACHE_AWARE = re.compile(r"cache_aware_read|cached_prefix_bytes")

# Read-then-write commands (tee, cp, sed -i, ...) must read FRESH so the
# write is not based on a stale cached copy; warm-serve is for pure readers.
# ``sed`` is registered write=True inside make_sed (not visible in the
# command file), so it is named explicitly.
_FRESH_READ_COMMANDS = {"sed.py"}


def _caching_backends() -> set[str]:
    """Backends whose resource serves reads from the file cache.

    Detected from the resource source: any ``caches_reads`` set to a
    non-``False`` value (literal ``True`` or a runtime expression such as
    lancedb's ``config.uri.startswith(...)``).
    """
    out: set[str] = set()
    for d in _RESOURCE_DIR.iterdir():
        if not d.is_dir():
            continue
        text = "\n".join(p.read_text() for p in d.glob("*.py"))
        for line in text.splitlines():
            if "caches_reads" not in line or "=" not in line:
                continue
            rhs = line.split("=", 1)[1].strip()
            if rhs and not rhs.startswith("False"):
                out.add(d.name)
                break
    return out


def test_bespoke_read_commands_are_cache_aware():
    caching = _caching_backends()
    assert "s3" in caching and "dify" in caching, caching
    offenders: list[str] = []
    for backend in sorted(caching):
        cmd_dir = _BUILTIN_DIR / backend
        if not cmd_dir.is_dir():
            continue
        for f in sorted(cmd_dir.glob("*.py")):
            # Skip helper modules (not commands) and read-then-write
            # commands, which must read fresh rather than serve warm.
            if f.name.startswith("_") or f.name in _FRESH_READ_COMMANDS:
                continue
            text = f.read_text()
            if "write=True" in text:
                continue
            if _READER_IMPORT.search(text) and not _CACHE_AWARE.search(text):
                offenders.append(f"{backend}/{f.name}")
    assert not offenders, (
        "bespoke read commands on caching backends inject a raw reader "
        "instead of a cache-aware one (wrap it with "
        "mirage.cache.read_through.cache_aware_read_*): " +
        ", ".join(offenders))
