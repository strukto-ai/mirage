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

import importlib.metadata
import logging
from typing import Any, NamedTuple

from pydantic import ValidationError

from mirage.secrets.summary import error_summary
from mirage.vfs.base import BaseVFS
from mirage.vfs.loader import load_backend_class

logger = logging.getLogger(__name__)

ENTRY_POINT_GROUP = "mirage.vfs"


class VFSEntry(NamedTuple):
    vfs_path: str | type
    config_path: str | type | None


REGISTRY: dict[str, VFSEntry] = {
    "ram":
    VFSEntry("mirage.vfs.ram:RAMVFS", None),
    "disk":
    VFSEntry("mirage.vfs.disk:DiskVFS", None),
    "redis":
    VFSEntry("mirage.vfs.redis:RedisVFS", None),
    "s3":
    VFSEntry("mirage.vfs.s3:S3VFS", "mirage.vfs.s3:S3Config"),
    "gridfs":
    VFSEntry("mirage.vfs.gridfs:GridFSVFS", "mirage.vfs.gridfs:GridFSConfig"),
    "r2":
    VFSEntry("mirage.vfs.r2:R2VFS", "mirage.vfs.r2:R2Config"),
    "oci":
    VFSEntry("mirage.vfs.oci:OCIVFS", "mirage.vfs.oci:OCIConfig"),
    "supabase":
    VFSEntry("mirage.vfs.supabase:SupabaseVFS",
             "mirage.vfs.supabase:SupabaseConfig"),
    "gcs":
    VFSEntry("mirage.vfs.gcs:GCSVFS", "mirage.vfs.gcs:GCSConfig"),
    "minio":
    VFSEntry("mirage.vfs.minio:MinIOVFS", "mirage.vfs.minio:MinIOConfig"),
    "ceph":
    VFSEntry("mirage.vfs.ceph:CephVFS", "mirage.vfs.ceph:CephConfig"),
    "seaweedfs":
    VFSEntry("mirage.vfs.seaweedfs:SeaweedFSVFS",
             "mirage.vfs.seaweedfs:SeaweedFSConfig"),
    "wasabi":
    VFSEntry("mirage.vfs.wasabi:WasabiVFS", "mirage.vfs.wasabi:WasabiConfig"),
    "backblaze":
    VFSEntry("mirage.vfs.backblaze:BackblazeVFS",
             "mirage.vfs.backblaze:BackblazeConfig"),
    "digitalocean":
    VFSEntry("mirage.vfs.digitalocean:DigitalOceanVFS",
             "mirage.vfs.digitalocean:DigitalOceanConfig"),
    "tencent":
    VFSEntry("mirage.vfs.tencent:TencentVFS",
             "mirage.vfs.tencent:TencentConfig"),
    "aliyun":
    VFSEntry("mirage.vfs.aliyun:AliyunVFS", "mirage.vfs.aliyun:AliyunConfig"),
    "scaleway":
    VFSEntry("mirage.vfs.scaleway:ScalewayVFS",
             "mirage.vfs.scaleway:ScalewayConfig"),
    "qingstor":
    VFSEntry("mirage.vfs.qingstor:QingStorVFS",
             "mirage.vfs.qingstor:QingStorConfig"),
    "hf_buckets":
    VFSEntry("mirage.vfs.hf_buckets:HfBucketsVFS",
             "mirage.vfs.hf_buckets:HfBucketsConfig"),
    "hf_datasets":
    VFSEntry("mirage.vfs.hf_datasets:HfDatasetsVFS",
             "mirage.vfs.hf_datasets:HfDatasetsConfig"),
    "hf_models":
    VFSEntry("mirage.vfs.hf_models:HfModelsVFS",
             "mirage.vfs.hf_models:HfModelsConfig"),
    "hf_spaces":
    VFSEntry("mirage.vfs.hf_spaces:HfSpacesVFS",
             "mirage.vfs.hf_spaces:HfSpacesConfig"),
    "onedrive":
    VFSEntry("mirage.vfs.onedrive:OneDriveVFS",
             "mirage.vfs.onedrive:OneDriveConfig"),
    "sharepoint":
    VFSEntry("mirage.vfs.sharepoint:SharePointVFS",
             "mirage.vfs.sharepoint:SharePointConfig"),
    "box":
    VFSEntry("mirage.vfs.box:BoxVFS", "mirage.vfs.box:BoxConfig"),
    "dropbox":
    VFSEntry("mirage.vfs.dropbox:DropboxVFS",
             "mirage.vfs.dropbox:DropboxConfig"),
    "github":
    VFSEntry("mirage.vfs.github:GitHubVFS", "mirage.vfs.github:GitHubConfig"),
    "wandb":
    VFSEntry("mirage.vfs.wandb:WandbVFS", "mirage.vfs.wandb:WandbConfig"),
    "linear":
    VFSEntry("mirage.vfs.linear:LinearVFS", "mirage.vfs.linear:LinearConfig"),
    "gcal":
    VFSEntry("mirage.vfs.gcal:GCalVFS", "mirage.vfs.gcal:GCalConfig"),
    "gdocs":
    VFSEntry("mirage.vfs.gdocs:GDocsVFS", "mirage.vfs.gdocs:GDocsConfig"),
    "gsheets":
    VFSEntry("mirage.vfs.gsheets:GSheetsVFS",
             "mirage.vfs.gsheets:GSheetsConfig"),
    "gslides":
    VFSEntry("mirage.vfs.gslides:GSlidesVFS",
             "mirage.vfs.gslides:GSlidesConfig"),
    "gdrive":
    VFSEntry("mirage.vfs.gdrive:GoogleDriveVFS",
             "mirage.vfs.gdrive:GoogleDriveConfig"),
    "slack":
    VFSEntry("mirage.vfs.slack:SlackVFS", "mirage.vfs.slack:SlackConfig"),
    "discord":
    VFSEntry("mirage.vfs.discord:DiscordVFS",
             "mirage.vfs.discord:DiscordConfig"),
    "gmail":
    VFSEntry("mirage.vfs.gmail:GmailVFS", "mirage.vfs.gmail:GmailConfig"),
    "trello":
    VFSEntry("mirage.vfs.trello:TrelloVFS", "mirage.vfs.trello:TrelloConfig"),
    "mongodb":
    VFSEntry("mirage.vfs.mongodb:MongoDBVFS",
             "mirage.vfs.mongodb:MongoDBConfig"),
    "postgres":
    VFSEntry("mirage.vfs.postgres:PostgresVFS",
             "mirage.vfs.postgres:PostgresConfig"),
    "notion":
    VFSEntry("mirage.vfs.notion:NotionVFS", "mirage.vfs.notion:NotionConfig"),
    "langfuse":
    VFSEntry("mirage.vfs.langfuse:LangfuseVFS",
             "mirage.vfs.langfuse:LangfuseConfig"),
    "jaeger":
    VFSEntry("mirage.vfs.jaeger:JaegerVFS", "mirage.vfs.jaeger:JaegerConfig"),
    "ssh":
    VFSEntry("mirage.vfs.ssh:SSHVFS", "mirage.vfs.ssh:SSHConfig"),
    "email":
    VFSEntry("mirage.vfs.email:EmailVFS", "mirage.vfs.email:EmailConfig"),
    "dify":
    VFSEntry("mirage.vfs.dify:DifyVFS", "mirage.vfs.dify:DifyConfig"),
    "mem0":
    VFSEntry("mirage.vfs.mem0:Mem0VFS", "mirage.vfs.mem0:Mem0Config"),
    "chroma":
    VFSEntry("mirage.vfs.chroma:ChromaVFS", "mirage.vfs.chroma:ChromaConfig"),
    "databricks_volume":
    VFSEntry("mirage.vfs.databricks_volume:DatabricksVolumeVFS",
             "mirage.vfs.databricks_volume:DatabricksVolumeConfig"),
    "nextcloud":
    VFSEntry("mirage.vfs.nextcloud:NextcloudVFS",
             "mirage.vfs.nextcloud:NextcloudConfig"),
    "lancedb":
    VFSEntry("mirage.vfs.lancedb:LanceDBVFS",
             "mirage.vfs.lancedb:LanceDBConfig"),
    "qdrant":
    VFSEntry("mirage.vfs.qdrant:QdrantVFS", "mirage.vfs.qdrant:QdrantConfig"),
}

_CUSTOM: dict[str, VFSEntry] = {}
_entry_points_loaded = False


def register_vfs(
    name: str,
    vfs: str | type,
    config: str | type | None = None,
) -> None:
    """Register a third-party VFS under a registry name.

    Registered names work everywhere builtin names do: workspace YAML,
    snapshots, and the daemon construct the VFS via
    :func:`build_vfs`. Builtin names cannot be shadowed;
    re-registering a custom name replaces it.

    Args:
        name (str): registry key such as ``"jira"``.
        vfs (str | type): the VFS class, or a loader spec —
            ``"./my_backend.py:MyVFS"`` or
            ``"mypackage.backends:MyVFS"``.
        config (str | type | None): the config class (or loader spec)
            when the VFS takes a typed config; None passes raw
            kwargs to the VFS constructor.
    """
    if name in REGISTRY:
        raise ValueError(f"cannot register {name!r}: shadows a builtin")
    _CUSTOM[name] = VFSEntry(vfs, config)


def _load_entry_point_vfs() -> None:
    """Discover VFS classes installed packages expose via entry points.

    Any package can ship a VFS by declaring, in its own
    pyproject.toml::

        [project.entry-points."mirage.vfs"]
        jira = "mypackage.backends:JiraVFS"

    The entry point must resolve to the VFS class; a typed config
    class is picked up from its ``CONFIG_CLS`` attribute when present.
    Builtin and explicitly registered names win over entry points.
    """
    global _entry_points_loaded
    if _entry_points_loaded:
        return
    _entry_points_loaded = True
    for ep in importlib.metadata.entry_points(group=ENTRY_POINT_GROUP):
        if ep.name in REGISTRY or ep.name in _CUSTOM:
            logger.debug("entry point %r shadowed by existing VFS", ep.name)
            continue
        _CUSTOM[ep.name] = VFSEntry(ep.value, None)


def known_vfs_names() -> list[str]:
    """All constructible registry names (builtin, registered, installed)."""
    _load_entry_point_vfs()
    return sorted({*REGISTRY, *_CUSTOM})


def resolve_class(ref: str | type) -> type:
    """Resolve a registry class reference: a class passes through, a
    loader spec string loads via :func:`load_backend_class`.

    Args:
        ref (str | type): class object or ``"source:ClassName"`` spec.
    """
    return ref if isinstance(ref, type) else load_backend_class(ref)


def resolve_entry(name: str) -> VFSEntry | None:
    """Find the entry a mount's ``vfs`` value names, or None.

    Four rungs, in the order ``commands.cli.specs.cli_spec_for`` uses for
    a ``cli`` value, because the two are the same question asked of two
    tiers: builtin, explicitly registered, a colon reference naming code
    directly, then ``mirage.vfs`` entry points.

    The colon rung needs no loader of its own. ``resolve_class`` already
    reads a ``"source:ClassName"`` string, so the reference becomes an
    ordinary entry with no config class, which means an out-of-tree class
    carrying ``CONFIG_CLS`` gets its typed config built exactly as a
    builtin's does. It is tried before the entry points because a colon
    is unambiguous: the value names code, so there is nothing to discover
    and no reason to pay for a scan of every installed package.

    Args:
        name (str): the mount's ``vfs`` value.
    """
    entry = REGISTRY.get(name) or _CUSTOM.get(name)
    if entry is not None:
        return entry
    if ":" in name:
        return VFSEntry(name, None)
    _load_entry_point_vfs()
    return _CUSTOM.get(name)


def _vfs_defect(built: BaseVFS) -> str | None:
    """The reason a colon-referenced class cannot serve as a VFS.

    A sentence rather than a bool, because a colon reference loads
    whatever the module exports and "did not build a VFS" does not
    tell the author what is wrong. Only that rung is checked: a builtin
    is known good, and ``register_vfs`` is called by the embedding
    program rather than by a line an agent types.

    The subclass check is the contract, not a structural one, because
    that is what the mount door enforces:
    ``workspace/workspace/mounts.py::check_vfs`` refuses anything
    failing ``isinstance(VFS, BaseVFS)``. A structural check
    here would accept a class that supplies every member and then watch
    it be rejected two doors later, which is the opposite of what this
    guard is for. Deliberately unlike the TypeScript twin, which does
    check members: ``VFS`` is an interface there, erased at runtime,
    so structural is the only contract there is and nothing downstream
    can ask for more. Here ``BaseVFS`` supplies every member, so a
    subclass cannot be missing one and there is nothing left to check
    but the name.

    Args:
        built (BaseVFS): the instance the referenced class produced.
    """
    if not isinstance(built, BaseVFS):
        return (f"built a {type(built).__name__}, which is not a "
                "BaseVFS subclass")
    # A VFS is keyed by its name: it is how a command or op
    # registered for this backend is found, so an empty one silently
    # registers nothing.
    if not isinstance(built.name, str) or not built.name:
        return "has no name"
    return None


def build_vfs(name: str, config: dict[str, Any] | None = None) -> BaseVFS:
    """Construct a VFS instance by its registry name.

    Resolves VFS and config classes lazily via importlib, so
    importing this module does not pull in every VFS's
    dependencies. Only the VFS classes actually used get loaded. Lookup
    order: builtin ``REGISTRY``, then :func:`register_vfs` names,
    then a colon reference naming a class directly
    (``./wiki.py:WikiVFS`` or ``mypkg.backends:WikiVFS``), then
    ``mirage.vfs`` entry points from installed packages. See
    :func:`resolve_entry`.

    **Synchronous on purpose. Do not make this async.** It is the door
    every caller who describes a mount as data comes through: the YAML
    loader (:meth:`mirage.config.WorkspaceConfig.to_workspace_kwargs`),
    the daemon's create/load routes, ``clone``, and every embedder
    reaching it through the ``mirage`` root. 0.0.5 made it async to let one
    backend fetch over the network at build time; that broke every
    out-of-tree caller, and because nothing validated the return value
    the failure surfaced as ``'coroutine' object has no attribute
    'set_index'`` two frames away in ``install_mounts``. Reverted in
    0.0.6.

    A backend whose setup needs I/O hydrates lazily on first use, the
    way ``github`` does through ``ensure_tree`` /
    ``ensure_default_branch``, and never from ``__init__``, which cannot
    await and so would have to block the caller's event loop. This is a
    deliberate divergence from the TypeScript ``buildVfs``, which
    stays ``Promise<VFS>`` because two of its backends
    (``github``, ``databricks_volume``) construct through
    ``static async create``.

    Args:
        name (str): registry key such as ``"s3"`` or ``"ram"``, or a
            colon reference such as ``"./wiki.py:WikiVFS"``.
        config (dict | None): kwargs for the VFS's ``Config``
            class when one exists; otherwise raw VFS kwargs
            (e.g. ``{"root": "/tmp"}`` for ``"disk"``).

    Returns:
        BaseVFS: a fresh VFS instance.

    Raises:
        KeyError: ``name`` is neither builtin, registered, a colon
            reference, nor installed.
    """
    entry = resolve_entry(name)
    if entry is None:
        raise KeyError(f"unknown VFS {name!r}; known: {known_vfs_names()}")
    vfs_cls = resolve_class(entry.vfs_path)
    cfg_dict = dict(config or {})
    config_ref = entry.config_path
    if config_ref is None:
        config_ref = getattr(vfs_cls, "CONFIG_CLS", None)
    try:
        if config_ref is None:
            built = vfs_cls(**cfg_dict)
        else:
            config_cls = resolve_class(config_ref)
            built = vfs_cls(config_cls(**cfg_dict))
    except ValidationError as exc:
        # A mount config is where a fetched credential lands, and the
        # create route answers `str(e)` as its 400 detail: pydantic's
        # own rendering would hand the refused value straight back to a
        # caller whose only way to name it was a pointer. The chain is
        # cut for the same reason; a logged traceback prints `__cause__`.
        raise ValueError(f"{name}: {error_summary(exc)}") from None
    if ":" in name:
        defect = _vfs_defect(built)
        if defect is not None:
            raise TypeError(f"VFS ref {name!r} {defect}")
    built.vfs_ref = name
    return built
