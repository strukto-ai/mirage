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

from typing import TYPE_CHECKING, NamedTuple

from mirage.resource.loader import load_backend_class

if TYPE_CHECKING:
    from mirage.resource.base import BaseResource


class ResourceEntry(NamedTuple):
    resource_path: str
    config_path: str | None


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


def build_resource(name: str, config: dict | None = None) -> "BaseResource":
    """Construct a resource instance by its registry name.

    Resolves resource and config classes lazily via importlib, so
    importing this module does not pull in every resource's
    dependencies. Only the resources actually used get loaded.

    Args:
        name (str): registry key such as ``"s3"`` or ``"ram"``.
        config (dict | None): kwargs for the resource's ``Config``
            class when one exists; otherwise raw resource kwargs
            (e.g. ``{"root": "/tmp"}`` for ``"disk"``).

    Returns:
        BaseResource: a fresh resource instance.

    Raises:
        KeyError: ``name`` is not in ``REGISTRY``.
    """
    if name not in REGISTRY:
        raise KeyError(f"unknown resource {name!r}; known: {sorted(REGISTRY)}")
    entry = REGISTRY[name]
    resource_cls = load_backend_class(entry.resource_path)
    cfg_dict = dict(config or {})
    if entry.config_path is None:
        return resource_cls(**cfg_dict)
    config_cls = load_backend_class(entry.config_path)
    return resource_cls(config_cls(**cfg_dict))
