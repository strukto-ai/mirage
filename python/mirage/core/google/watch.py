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

from functools import partial
from typing import TypeVar

from mirage.accessor.google_api import GoogleApiAccessor
from mirage.core.hierarchy.probe import ReaddirFn
from mirage.types import StatFn
from mirage.watch.base import DeltaHook
from mirage.watch.delta import ListingDeltaHook
from mirage.watch.walk import ReaddirWalk

G = TypeVar("G", bound=GoogleApiAccessor)


def app_delta_hook(
    accessor: G,
    readdir: ReaddirFn[G],
    stat: StatFn,
) -> DeltaHook:
    """The delta hook of a Google app mount: its own tree, walked.

    A pull lists each corpus once, one Drive query narrowed to the app's
    MIME type, and fingerprints a file by the modified time its stat
    reports. An edit on another day renames the file, since the date
    leads the name, and reads as one file gone and another made.

    Args:
        accessor (GoogleApiAccessor): backend accessor.
        readdir (ReaddirFn): the app's readdir.
        stat (StatFn): the app's stat.
    """
    return ListingDeltaHook(
        ReaddirWalk(partial(readdir, accessor), partial(stat, accessor))
    )
