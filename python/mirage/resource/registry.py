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
from typing import TYPE_CHECKING, Any, NamedTuple

from mirage.resource.loader import load_backend_class

if TYPE_CHECKING:
    from mirage.resource.base import BaseResource

logger = logging.getLogger(__name__)

ENTRY_POINT_GROUP = "mirage.resources"


class ResourceEntry(NamedTuple):
    resource_path: str | type
    config_path: str | type | None


REGISTRY: dict[str, ResourceEntry] = {
    "ram":
    ResourceEntry("mirage.resource.ram:RAMResource", None),
    "disk":
    ResourceEntry("mirage.resource.disk:DiskResource", None),
    "redis":
    ResourceEntry("mirage.resource.redis:RedisResource", None),
    "s3":
    ResourceEntry("mirage.resource.s3:S3Resource",
                  "mirage.resource.s3:S3Config"),
    "gridfs":
    ResourceEntry("mirage.resource.gridfs:GridFSResource",
                  "mirage.resource.gridfs:GridFSConfig"),
    "r2":
    ResourceEntry("mirage.resource.r2:R2Resource",
                  "mirage.resource.r2:R2Config"),
    "oci":
    ResourceEntry("mirage.resource.oci:OCIResource",
                  "mirage.resource.oci:OCIConfig"),
    "supabase":
    ResourceEntry("mirage.resource.supabase:SupabaseResource",
                  "mirage.resource.supabase:SupabaseConfig"),
    "gcs":
    ResourceEntry("mirage.resource.gcs:GCSResource",
                  "mirage.resource.gcs:GCSConfig"),
    "minio":
    ResourceEntry("mirage.resource.minio:MinIOResource",
                  "mirage.resource.minio:MinIOConfig"),
    "ceph":
    ResourceEntry("mirage.resource.ceph:CephResource",
                  "mirage.resource.ceph:CephConfig"),
    "seaweedfs":
    ResourceEntry("mirage.resource.seaweedfs:SeaweedFSResource",
                  "mirage.resource.seaweedfs:SeaweedFSConfig"),
    "wasabi":
    ResourceEntry("mirage.resource.wasabi:WasabiResource",
                  "mirage.resource.wasabi:WasabiConfig"),
    "backblaze":
    ResourceEntry("mirage.resource.backblaze:BackblazeResource",
                  "mirage.resource.backblaze:BackblazeConfig"),
    "digitalocean":
    ResourceEntry("mirage.resource.digitalocean:DigitalOceanResource",
                  "mirage.resource.digitalocean:DigitalOceanConfig"),
    "tencent":
    ResourceEntry("mirage.resource.tencent:TencentResource",
                  "mirage.resource.tencent:TencentConfig"),
    "aliyun":
    ResourceEntry("mirage.resource.aliyun:AliyunResource",
                  "mirage.resource.aliyun:AliyunConfig"),
    "scaleway":
    ResourceEntry("mirage.resource.scaleway:ScalewayResource",
                  "mirage.resource.scaleway:ScalewayConfig"),
    "qingstor":
    ResourceEntry("mirage.resource.qingstor:QingStorResource",
                  "mirage.resource.qingstor:QingStorConfig"),
    "hf_buckets":
    ResourceEntry("mirage.resource.hf_buckets:HfBucketsResource",
                  "mirage.resource.hf_buckets:HfBucketsConfig"),
    "hf_datasets":
    ResourceEntry("mirage.resource.hf_datasets:HfDatasetsResource",
                  "mirage.resource.hf_datasets:HfDatasetsConfig"),
    "hf_models":
    ResourceEntry("mirage.resource.hf_models:HfModelsResource",
                  "mirage.resource.hf_models:HfModelsConfig"),
    "hf_spaces":
    ResourceEntry("mirage.resource.hf_spaces:HfSpacesResource",
                  "mirage.resource.hf_spaces:HfSpacesConfig"),
    "onedrive":
    ResourceEntry("mirage.resource.onedrive:OneDriveResource",
                  "mirage.resource.onedrive:OneDriveConfig"),
    "box":
    ResourceEntry("mirage.resource.box:BoxResource",
                  "mirage.resource.box:BoxConfig"),
    "dropbox":
    ResourceEntry("mirage.resource.dropbox:DropboxResource",
                  "mirage.resource.dropbox:DropboxConfig"),
    "github":
    ResourceEntry("mirage.resource.github:GitHubResource",
                  "mirage.resource.github:GitHubConfig"),
    "github_ci":
    ResourceEntry("mirage.resource.github_ci:GitHubCIResource",
                  "mirage.resource.github_ci:GitHubCIConfig"),
    "linear":
    ResourceEntry("mirage.resource.linear:LinearResource",
                  "mirage.resource.linear:LinearConfig"),
    "gdocs":
    ResourceEntry("mirage.resource.gdocs:GDocsResource",
                  "mirage.resource.gdocs:GDocsConfig"),
    "gsheets":
    ResourceEntry("mirage.resource.gsheets:GSheetsResource",
                  "mirage.resource.gsheets:GSheetsConfig"),
    "gslides":
    ResourceEntry("mirage.resource.gslides:GSlidesResource",
                  "mirage.resource.gslides:GSlidesConfig"),
    "gdrive":
    ResourceEntry("mirage.resource.gdrive:GoogleDriveResource",
                  "mirage.resource.gdrive:GoogleDriveConfig"),
    "slack":
    ResourceEntry("mirage.resource.slack:SlackResource",
                  "mirage.resource.slack:SlackConfig"),
    "discord":
    ResourceEntry("mirage.resource.discord:DiscordResource",
                  "mirage.resource.discord:DiscordConfig"),
    "gmail":
    ResourceEntry("mirage.resource.gmail:GmailResource",
                  "mirage.resource.gmail:GmailConfig"),
    "trello":
    ResourceEntry("mirage.resource.trello:TrelloResource",
                  "mirage.resource.trello:TrelloConfig"),
    "mongodb":
    ResourceEntry("mirage.resource.mongodb:MongoDBResource",
                  "mirage.resource.mongodb:MongoDBConfig"),
    "postgres":
    ResourceEntry("mirage.resource.postgres:PostgresResource",
                  "mirage.resource.postgres:PostgresConfig"),
    "notion":
    ResourceEntry("mirage.resource.notion:NotionResource",
                  "mirage.resource.notion:NotionConfig"),
    "langfuse":
    ResourceEntry("mirage.resource.langfuse:LangfuseResource",
                  "mirage.resource.langfuse:LangfuseConfig"),
    "ssh":
    ResourceEntry("mirage.resource.ssh:SSHResource",
                  "mirage.resource.ssh:SSHConfig"),
    "email":
    ResourceEntry("mirage.resource.email:EmailResource",
                  "mirage.resource.email:EmailConfig"),
    "dify":
    ResourceEntry("mirage.resource.dify:DifyResource",
                  "mirage.resource.dify:DifyConfig"),
    "chroma":
    ResourceEntry("mirage.resource.chroma:ChromaResource",
                  "mirage.resource.chroma:ChromaConfig"),
    "databricks_volume":
    ResourceEntry("mirage.resource.databricks_volume:DatabricksVolumeResource",
                  "mirage.resource.databricks_volume:DatabricksVolumeConfig"),
    "nextcloud":
    ResourceEntry("mirage.resource.nextcloud:NextcloudResource",
                  "mirage.resource.nextcloud:NextcloudConfig"),
    "lancedb":
    ResourceEntry("mirage.resource.lancedb:LanceDBResource",
                  "mirage.resource.lancedb:LanceDBConfig"),
    "qdrant":
    ResourceEntry("mirage.resource.qdrant:QdrantResource",
                  "mirage.resource.qdrant:QdrantConfig"),
}

_CUSTOM: dict[str, ResourceEntry] = {}
_entry_points_loaded = False


def register_resource(
    name: str,
    resource: str | type,
    config: str | type | None = None,
) -> None:
    """Register a third-party resource under a registry name.

    Registered names work everywhere builtin names do: workspace YAML,
    snapshots, and the daemon construct the resource via
    :func:`build_resource`. Builtin names cannot be shadowed;
    re-registering a custom name replaces it.

    Args:
        name (str): registry key such as ``"jira"``.
        resource (str | type): the resource class, or a loader spec —
            ``"./my_backend.py:MyResource"`` or
            ``"mypackage.backends:MyResource"``.
        config (str | type | None): the config class (or loader spec)
            when the resource takes a typed config; None passes raw
            kwargs to the resource constructor.
    """
    if name in REGISTRY:
        raise ValueError(f"cannot register {name!r}: shadows a builtin")
    _CUSTOM[name] = ResourceEntry(resource, config)


def _load_entry_point_resources() -> None:
    """Discover resources installed packages expose via entry points.

    Any package can ship a resource by declaring, in its own
    pyproject.toml::

        [project.entry-points."mirage.resources"]
        jira = "mypackage.backends:JiraResource"

    The entry point must resolve to the resource class; a typed config
    class is picked up from its ``CONFIG_CLS`` attribute when present.
    Builtin and explicitly registered names win over entry points.
    """
    global _entry_points_loaded
    if _entry_points_loaded:
        return
    _entry_points_loaded = True
    for ep in importlib.metadata.entry_points(group=ENTRY_POINT_GROUP):
        if ep.name in REGISTRY or ep.name in _CUSTOM:
            logger.debug("entry point %r shadowed by existing resource",
                         ep.name)
            continue
        _CUSTOM[ep.name] = ResourceEntry(ep.value, None)


def known_resources() -> list[str]:
    """All constructible registry names (builtin, registered, installed)."""
    _load_entry_point_resources()
    return sorted({*REGISTRY, *_CUSTOM})


def resolve_class(ref: str | type) -> type:
    """Resolve a registry class reference: a class passes through, a
    loader spec string loads via :func:`load_backend_class`.

    Args:
        ref (str | type): class object or ``"source:ClassName"`` spec.
    """
    return ref if isinstance(ref, type) else load_backend_class(ref)


def build_resource(name: str,
                   config: dict[str, Any] | None = None) -> "BaseResource":
    """Construct a resource instance by its registry name.

    Resolves resource and config classes lazily via importlib, so
    importing this module does not pull in every resource's
    dependencies. Only the resources actually used get loaded. Lookup
    order: builtin ``REGISTRY``, then :func:`register_resource` names,
    then ``mirage.resources`` entry points from installed packages.

    Args:
        name (str): registry key such as ``"s3"`` or ``"ram"``.
        config (dict | None): kwargs for the resource's ``Config``
            class when one exists; otherwise raw resource kwargs
            (e.g. ``{"root": "/tmp"}`` for ``"disk"``).

    Returns:
        BaseResource: a fresh resource instance.

    Raises:
        KeyError: ``name`` is neither builtin, registered, nor
            installed.
    """
    entry = REGISTRY.get(name)
    if entry is None:
        _load_entry_point_resources()
        entry = _CUSTOM.get(name)
    if entry is None:
        raise KeyError(
            f"unknown resource {name!r}; known: {known_resources()}")
    resource_cls = resolve_class(entry.resource_path)
    cfg_dict = dict(config or {})
    config_ref = entry.config_path
    if config_ref is None:
        config_ref = getattr(resource_cls, "CONFIG_CLS", None)
    if config_ref is None:
        return resource_cls(**cfg_dict)
    config_cls = resolve_class(config_ref)
    return resource_cls(config_cls(**cfg_dict))
