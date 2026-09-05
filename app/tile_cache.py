"""Bounded PNG cache. Calls are serialized by the caller during cache writes."""
from pathlib import Path
import os


class TileCache:
    def __init__(self, root, max_bytes=128 * 1024 * 1024):
        self.root = Path(root)
        self.max_bytes = max_bytes
        self.entries = None
        self.size = 0

    def _load(self):
        self.entries = {}
        if self.root.exists():
            for p in self.root.rglob("*.png"):
                if p.is_file() and not p.is_symlink():
                    st = p.stat()
                    self.entries[p] = (st.st_mtime_ns, st.st_size)
                    self.size += st.st_size
        self._trim(0)

    def _trim(self, incoming):
        while self.entries and self.size + incoming > self.max_bytes:
            p = min(self.entries, key=lambda key: self.entries[key][0])
            _, size = self.entries.pop(p)
            p.unlink(missing_ok=True)
            self.size -= size
            # Remove empty tile-coordinate directories, keeping the cache root.
            for parent in (p.parent, p.parent.parent):
                if parent != self.root:
                    try:
                        parent.rmdir()
                    except OSError:
                        pass

    def put(self, path, data):
        if self.entries is None:
            self._load()
        path = Path(path)
        if len(data) > self.max_bytes:
            return
        old = self.entries.pop(path, None)
        if old:
            self.size -= old[1]
        self._trim(len(data))
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, path)
        self.entries[path] = (path.stat().st_mtime_ns, len(data))
        self.size += len(data)
