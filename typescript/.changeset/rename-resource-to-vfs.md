---
'@struktoai/mirage-core': minor
'@struktoai/mirage-node': minor
'@struktoai/mirage-browser': minor
'@struktoai/mirage-cli': minor
'@struktoai/mirage-server': minor
'@struktoai/mirage-agents': minor
'@struktoai/mirage-dsh': minor
---

Rename the backend adapter concept from `Resource` to `VFS`: every `*Resource` class is now `*VFS` (`RAMVFS`, `S3VFS`, `BaseVFS`, `GenericVFS`), `buildResource` is `buildVfs`, `knownResources` is `knownVfsNames`, `resourcePath` is `vfsPath`, the YAML mount key `resource:` is `vfs:`, and `Workspace` takes `mounts`. The default executor and reach previously spelled `'vfs'` are now `'workspace'`, as is `MountBackend.WORKSPACE`.
