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

from mirage.core.google.constants import CORPUS
from mirage.core.hierarchy.codec import Codec
from mirage.core.hierarchy.scope import Scope, Slot
from mirage.types import ContentType


def app_scopes(file_name: Codec) -> tuple[Scope, ...]:
    """The tree of a Google app mount: its corpora and their files.

    One description per app: readdir, stat, read and unlink all classify
    through it, so the file surface and the write surface cannot disagree
    about what a path means. Sheets, Docs and Slides differ only in the
    pattern a file name matches.

    Args:
        file_name (Codec): the codec of the app's file names.
    """
    return (
        Scope(kind="corpus", segments=(Slot("corpus", CORPUS),), probed=False),
        Scope(
            kind="file",
            segments=(
                Slot("corpus", CORPUS),
                Slot("name", file_name, id_key="file_id"),
            ),
            leaf=True,
            filetype=ContentType.JSON,
        ),
    )
