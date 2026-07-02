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

import json

from mirage.accessor.github_ci import GitHubCIAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.github_ci.annotations import list_annotations
from mirage.core.github_ci.artifacts import download_artifact
from mirage.core.github_ci.runs import (download_job_log, get_job, get_run,
                                        list_jobs_for_run)
from mirage.core.github_ci.workflows import get_workflow
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_prefix_of


async def read(
    accessor: GitHubCIAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> bytes:
    if isinstance(path, str):
        path = PathSpec(virtual=path,
                        directory=path,
                        resource_path=path.strip("/"))
    virtual = path.virtual
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    key = path.resource_path
    parts = key.split("/")

    # /workflows/<name>_<id>.json
    if len(parts) == 2 and parts[0] == "workflows" and parts[1].endswith(
            ".json"):
        if index is None:
            raise enoent(virtual)
        virtual_key = prefix + "/" + key
        lookup = await index.get(virtual_key)
        if lookup.entry is None:
            raise enoent(virtual)
        wf = await get_workflow(accessor.config, lookup.entry.id)
        return json.dumps(wf, indent=2, ensure_ascii=False).encode()

    # /runs/<workflow>_<run-id>/run.json
    if (len(parts) == 3 and parts[0] == "runs" and parts[2] == "run.json"):
        if index is None:
            raise enoent(virtual)
        run_virtual = prefix + "/" + f"{parts[0]}/{parts[1]}"
        lookup = await index.get(run_virtual)
        if lookup.entry is None:
            raise enoent(virtual)
        run = await get_run(accessor.config, lookup.entry.id)
        return json.dumps(run, indent=2, ensure_ascii=False).encode()

    # /runs/<workflow>_<run-id>/annotations.jsonl
    if (len(parts) == 3 and parts[0] == "runs"
            and parts[2] == "annotations.jsonl"):
        if index is None:
            raise enoent(virtual)
        run_virtual = prefix + "/" + f"{parts[0]}/{parts[1]}"
        lookup = await index.get(run_virtual)
        if lookup.entry is None:
            raise enoent(virtual)
        jobs = await list_jobs_for_run(accessor.config, lookup.entry.id)
        lines = []
        for j in jobs:
            anns = await list_annotations(accessor.config, str(j["id"]))
            for a in anns:
                lines.append(
                    json.dumps(a, ensure_ascii=False, separators=(",", ":")))
        if lines:
            return ("\n".join(lines) + "\n").encode()
        return b""

    # /runs/<workflow>_<run-id>/jobs/<job>_<job-id>.json
    if (len(parts) == 4 and parts[0] == "runs" and parts[2] == "jobs"
            and parts[3].endswith(".json")):
        if index is None:
            raise enoent(virtual)
        virtual_key = prefix + "/" + key
        lookup = await index.get(virtual_key)
        if lookup.entry is None:
            raise enoent(virtual)
        job = await get_job(accessor.config, lookup.entry.id)
        return json.dumps(job, indent=2, ensure_ascii=False).encode()

    # /runs/<workflow>_<run-id>/jobs/<job>_<job-id>.log
    if (len(parts) == 4 and parts[0] == "runs" and parts[2] == "jobs"
            and parts[3].endswith(".log")):
        if index is None:
            raise enoent(virtual)
        virtual_key = prefix + "/" + key
        lookup = await index.get(virtual_key)
        if lookup.entry is None:
            raise enoent(virtual)
        return await download_job_log(accessor.config, lookup.entry.id)

    # /runs/<workflow>_<run-id>/artifacts/<name>_<id>.zip
    if (len(parts) == 4 and parts[0] == "runs" and parts[2] == "artifacts"):
        if index is None:
            raise enoent(virtual)
        virtual_key = prefix + "/" + key
        lookup = await index.get(virtual_key)
        if lookup.entry is None:
            raise enoent(virtual)
        return await download_artifact(accessor.config, lookup.entry.id)

    raise enoent(virtual)
