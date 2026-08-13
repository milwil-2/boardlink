from __future__ import annotations

import json
import os
from typing import Dict, List, Protocol, runtime_checkable

# Climb names are global, static data (not per-user), so one shared backing store safely serves every
# user of an app. The default is a JSON file, but a deploy (serverless, multi-worker) can swap in a
# Redis/DB/S3-backed store by supplying any object satisfying this protocol. Resolution happens in
# batches, so the interface is batch-shaped to keep round-trips to one per resolve.


@runtime_checkable
class NameCache(Protocol):
    def get_many(self, keys: List[str]) -> Dict[str, str]:
        """Return the subset of ``keys`` that are cached, as ``{key: name}``. Unknown keys are absent."""
        ...

    def set_many(self, mapping: Dict[str, str]) -> None:
        """Persist newly resolved ``{key: name}`` entries."""
        ...


class FileNameCache:
    """Default ``NameCache``: a single JSON file, ``{uuid: name}``.

    Reads tolerate a missing or corrupt file (treated as empty). Writes are atomic (temp + os.replace)
    so an interrupted or concurrent write never leaves a partial file. ``ensure_ascii=False`` keeps
    non-ASCII climb names readable on disk. Only resolved names are ever stored; misses are not.
    """

    def __init__(self, path: str) -> None:
        self.path = path

    def _load(self) -> Dict[str, str]:
        try:
            with open(self.path, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return {}  # missing or corrupt cache is treated as empty
        return data if isinstance(data, dict) else {}

    def get_many(self, keys: List[str]) -> Dict[str, str]:
        cache = self._load()
        return {k: cache[k] for k in keys if k in cache}

    def set_many(self, mapping: Dict[str, str]) -> None:
        if not mapping:
            return
        # Re-read before merge so a concurrent writer's entries are not clobbered.
        cache = self._load()
        cache.update(mapping)
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = f"{self.path}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False)
        os.replace(tmp, self.path)  # atomic, so an interrupted write never corrupts the cache


# A deploy backs names with its own store by implementing the same two methods, e.g. Redis:
#
#     class RedisNameCache:
#         def __init__(self, client, prefix="boardlink:names:"):
#             self.client, self.prefix = client, prefix
#         def get_many(self, keys):
#             vals = self.client.mget([self.prefix + k for k in keys])
#             return {k: v for k, v in zip(keys, vals) if v is not None}
#         def set_many(self, mapping):
#             if mapping:
#                 self.client.mset({self.prefix + k: v for k, v in mapping.items()})
#
# then pass it as ``resolve_climb_names(..., cache=RedisNameCache(r))``.
