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

from mirage.accessor.github_ci import GitHubCIAccessor
from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.github_ci.artifacts import list_artifacts
from mirage.core.github_ci.runs import list_jobs_for_run, list_runs
from mirage.core.github_ci.workflows import list_workflows
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_key, mount_prefix_of


def _safe_name(name: str) -> str:
    if not name:
        return "unknown"
    return name.replace("/", "\u2215")


async def readdir(
    accessor: GitHubCIAccessor,
    path: PathSpec,
    index: IndexCacheStore,
) -> list[str]:
    virtual = path.virtual
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    path = (path.dir if path.pattern else path).mount_path
    key = path.strip("/")
    virtual_key = prefix + "/" + key if key else prefix or "/"

    if not key:
        return [f"{prefix}/workflows", f"{prefix}/runs"]

    parts = key.split("/")

    # /workflows
    if len(parts) == 1 and parts[0] == "workflows":
        if index is not None:
            listing = await index.list_dir(virtual_key)
            if listing.entries is not None:
                return listing.entries
        workflows = await list_workflows(accessor.config)
        entries = []
        names = []
        for wf in workflows:
            name = _safe_name(wf.get("name", str(wf["id"])))
            filename = f"{name}_{wf['id']}.json"
            entry = IndexEntry(
                id=str(wf["id"]),
                name=wf.get("name", ""),
                resource_type="ci/workflow",
                vfs_name=filename,
                remote_time=wf.get("updated_at", ""),
            )
            entries.append((filename, entry))
            names.append(f"{prefix}/{key}/{filename}")
        if index is not None:
            await index.set_dir(virtual_key, entries)
        return names

    # /runs
    if len(parts) == 1 and parts[0] == "runs":
        if index is not None:
            listing = await index.list_dir(virtual_key)
            if listing.entries is not None:
                return listing.entries
        runs = await list_runs(accessor.config, days=accessor.config.days)
        entries = []
        names = []
        for r in runs:
            wf_name = _safe_name(r.get("name", str(r["id"])))
            dirname = f"{wf_name}_{r['id']}"
            entry = IndexEntry(
                id=str(r["id"]),
                name=r.get("name", ""),
                resource_type="ci/run",
                vfs_name=dirname,
                remote_time=r.get("updated_at", ""),
            )
            entries.append((dirname, entry))
            names.append(f"{prefix}/{key}/{dirname}")
        if index is not None:
            await index.set_dir(virtual_key, entries)
        return names

    # /runs/<workflow>_<run-id>
    if len(parts) == 2 and parts[0] == "runs":
        if index is not None:
            lookup = await index.get(virtual_key)
            if lookup.entry is None:
                parent = PathSpec(
                    virtual=prefix + "/runs",
                    directory=prefix + "/runs",
                    resource_path=mount_key(prefix + "/runs", prefix),
                )
                await readdir(accessor, parent, index)
                lookup = await index.get(virtual_key)
            if lookup.entry is None:
                raise enoent(virtual)
        base = f"{prefix}/{key}"
        return [
            f"{base}/run.json",
            f"{base}/jobs",
            f"{base}/annotations.jsonl",
            f"{base}/artifacts",
        ]

    # /runs/<workflow>_<run-id>/jobs
    if len(parts) == 3 and parts[0] == "runs" and parts[2] == "jobs":
        if index is not None:
            listing = await index.list_dir(virtual_key)
            if listing.entries is not None:
                return listing.entries
            run_virtual = prefix + "/" + f"{parts[0]}/{parts[1]}"
            run_lookup = await index.get(run_virtual)
            if run_lookup.entry is None:
                parent = PathSpec(
                    virtual=prefix + "/runs",
                    directory=prefix + "/runs",
                    resource_path=mount_key(prefix + "/runs", prefix),
                )
                await readdir(accessor, parent, index)
                run_lookup = await index.get(run_virtual)
            if run_lookup.entry is None:
                raise enoent(virtual)
            run_id = run_lookup.entry.id
        else:
            raise enoent(virtual)
        jobs = await list_jobs_for_run(accessor.config, run_id)
        entries = []
        names = []
        for j in jobs:
            name = _safe_name(j.get("name", str(j["id"])))
            json_filename = f"{name}_{j['id']}.json"
            log_filename = f"{name}_{j['id']}.log"
            entry_json = IndexEntry(
                id=str(j["id"]),
                name=j.get("name", ""),
                resource_type="ci/job",
                vfs_name=json_filename,
                remote_time=j.get("completed_at", ""),
            )
            entry_log = IndexEntry(
                id=str(j["id"]),
                name=j.get("name", ""),
                resource_type="ci/job_log",
                vfs_name=log_filename,
                remote_time=j.get("completed_at", ""),
            )
            entries.append((json_filename, entry_json))
            entries.append((log_filename, entry_log))
            names.append(f"{prefix}/{key}/{json_filename}")
            names.append(f"{prefix}/{key}/{log_filename}")
        if index is not None:
            await index.set_dir(virtual_key, entries)
        return names

    # /runs/<workflow>_<run-id>/artifacts
    if len(parts) == 3 and parts[0] == "runs" and parts[2] == "artifacts":
        if index is not None:
            listing = await index.list_dir(virtual_key)
            if listing.entries is not None:
                return listing.entries
            run_virtual = prefix + "/" + f"{parts[0]}/{parts[1]}"
            run_lookup = await index.get(run_virtual)
            if run_lookup.entry is None:
                parent = PathSpec(
                    virtual=prefix + "/runs",
                    directory=prefix + "/runs",
                    resource_path=mount_key(prefix + "/runs", prefix),
                )
                await readdir(accessor, parent, index)
                run_lookup = await index.get(run_virtual)
            if run_lookup.entry is None:
                raise enoent(virtual)
            run_id = run_lookup.entry.id
        else:
            raise enoent(virtual)
        artifacts = await list_artifacts(accessor.config, run_id)
        entries = []
        names = []
        for a in artifacts:
            name = _safe_name(a.get("name", str(a["id"])))
            filename = f"{name}_{a['id']}.zip"
            entry = IndexEntry(
                id=str(a["id"]),
                name=a.get("name", ""),
                resource_type="ci/artifact",
                vfs_name=filename,
                size=a.get("size_in_bytes"),
                remote_time=a.get("updated_at", ""),
            )
            entries.append((filename, entry))
            names.append(f"{prefix}/{key}/{filename}")
        if index is not None:
            await index.set_dir(virtual_key, entries)
        return names

    return []


def is_dir_name(child: str) -> bool:
    # Entries are recognized by extension, so classification never needs
    # the stat fallback.
    name = child.rsplit("/", 1)[-1]
    return not (name.endswith(".json") or name.endswith(".jsonl")
                or name.endswith(".log") or name.endswith(".zip"))
