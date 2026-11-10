"""Write-once object storage (design §5, §10): put_if_absent, streaming and content addressing."""

from __future__ import annotations

import hashlib
import io
import threading

import pytest

from dermpath.storage import LocalObjectStore, ObjectConflictError, PutResult, S3ObjectStore, StoreError


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


@pytest.fixture()
def store(tmp_path) -> LocalObjectStore:
    return LocalObjectStore(tmp_path / "objects")


def _leftover_temps(store: LocalObjectStore) -> list[str]:
    return [str(p) for p in store.root.rglob("*.tmp")]


@pytest.mark.parametrize("kind", ["bytes", "path", "fileobj"])
def test_put_if_absent_creates_then_verifies_then_refuses(store, tmp_path, kind):
    def src(data: bytes):
        if kind == "bytes":
            return data
        if kind == "path":
            p = tmp_path / f"src-{sha(data)[:8]}"
            p.write_bytes(data)
            return p
        return io.BytesIO(data)

    first = store.put_if_absent("projects/p/features/a.npy", src(b"embeddings-v1"))
    assert first == PutResult("projects/p/features/a.npy", sha(b"embeddings-v1"), 13, True)
    again = store.put_if_absent("projects/p/features/a.npy", src(b"embeddings-v1"))
    assert again.created is False and again.sha256 == first.sha256
    with pytest.raises(ObjectConflictError) as exc:
        store.put_if_absent("projects/p/features/a.npy", src(b"embeddings-v2"))
    assert exc.value.actual_sha256 == first.sha256 and exc.value.expected_sha256 == sha(b"embeddings-v2")
    assert store.get_bytes("projects/p/features/a.npy") == b"embeddings-v1"  # never overwritten
    assert oct((store.root / "projects/p/features/a.npy").stat().st_mode & 0o777) == "0o600"
    assert _leftover_temps(store) == []


def test_put_if_absent_checks_the_expected_sha_before_publishing(store):
    with pytest.raises(StoreError, match="does not match the expected"):
        store.put_if_absent("k/x.bin", b"data", expected_sha256="0" * 64)
    assert not store.exists("k/x.bin") and _leftover_temps(store) == []
    with pytest.raises(StoreError):
        store.put_if_absent("../escape", b"x")


def test_put_if_absent_detects_a_corrupted_existing_object(store):
    store.put_if_absent("k/x.bin", b"good")
    (store.root / "k/x.bin").chmod(0o600)
    (store.root / "k/x.bin").write_bytes(b"bit-rot")
    with pytest.raises(ObjectConflictError):
        store.put_if_absent("k/x.bin", b"good")


def _race(n: int, fn):
    barrier = threading.Barrier(n)
    results: list = [None] * n

    def run(i):
        barrier.wait()
        try:
            results[i] = fn(i)
        except Exception as exc:  # collected and asserted by the caller
            results[i] = exc

    threads = [threading.Thread(target=run, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return results


def test_concurrent_writers_same_bytes_one_creates_the_others_verify(store):
    payload = b"x" * 300_000
    for round_ in range(5):
        key = f"projects/p/features/same-{round_}.npy"
        results = _race(8, lambda i: store.put_if_absent(key, payload))
        assert all(isinstance(r, PutResult) for r in results), results
        assert sum(r.created for r in results) == 1
        assert {r.sha256 for r in results} == {sha(payload)}
        assert store.get_bytes(key) == payload
    assert _leftover_temps(store) == []


def test_concurrent_writers_different_bytes_one_wins_the_others_are_refused(store):
    for round_ in range(5):
        key = f"projects/p/features/diff-{round_}.npy"
        payloads = [bytes([i]) * 200_000 for i in range(6)]
        results = _race(6, lambda i: store.put_if_absent(key, payloads[i]))
        winners = [i for i, r in enumerate(results) if isinstance(r, PutResult)]
        assert len(winners) == 1, results
        assert all(isinstance(r, ObjectConflictError) for i, r in enumerate(results) if i != winners[0])
        assert store.get_bytes(key) == payloads[winners[0]]
    assert _leftover_temps(store) == []


def test_legacy_overwriting_writes_use_unique_temp_names(store):
    """Regression (audit): concurrent put_bytes on one key raced on '<dest>.tmp'."""
    payloads = [bytes([i]) * 100_000 for i in range(8)]
    results = _race(8, lambda i: store.put_bytes("projects/p/runs/r/checkpoint.npz", payloads[i]))
    assert results == [100_000] * 8
    assert store.get_bytes("projects/p/runs/r/checkpoint.npz") in payloads
    assert _leftover_temps(store) == []


def test_put_content_addressed_is_idempotent_and_verifies(store, tmp_path):
    data = b"\x93NUMPY fake embeddings"
    key, digest = store.put_content_addressed("projects/p/features/emb", data, ".npy")
    assert digest == sha(data) and key == f"projects/p/features/emb/{digest}.npy"
    src = tmp_path / "e.npy"
    src.write_bytes(data)
    assert store.put_content_addressed("projects/p/features/emb/", src, ".npy") == (key, digest)
    assert store.put_content_addressed("projects/p/features/emb", io.BytesIO(data), ".npy") == (key, digest)
    (store.root / key).write_bytes(b"corrupted")
    with pytest.raises(ObjectConflictError):  # a corrupt object is never served as this sha
        store.put_content_addressed("projects/p/features/emb", data, ".npy")
    with pytest.raises(StoreError):
        store.put_content_addressed("../outside", data)
    assert _leftover_temps(store) == []


def test_put_file_streaming_returns_sha_and_size(store, tmp_path):
    big = bytes(range(256)) * 20_000  # 5 MB, streamed in 1 MiB blocks
    res = store.put_file_streaming("projects/p/slides/s/original.svs", io.BytesIO(big))
    assert res == PutResult("projects/p/slides/s/original.svs", sha(big), len(big), True)
    src = tmp_path / "f.bin"
    src.write_bytes(b"replacement")
    assert store.put_file_streaming("projects/p/slides/s/original.svs", src).sha256 == sha(b"replacement")
    assert store.get_bytes("projects/p/slides/s/original.svs") == b"replacement"  # overwrite semantics
    with pytest.raises(ObjectConflictError):
        store.put_file_streaming("projects/p/slides/s/original.svs", io.BytesIO(b"third"), if_absent=True)
    assert _leftover_temps(store) == []


# --------------------------------------------------------------------------- S3 (fake client)


class _ClientError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class ParamValidationError(Exception):  # same class name as botocore's
    pass


class FakeS3:
    """Enough of the boto3 client for put_if_absent; honours If-None-Match like S3."""

    def __init__(self, supports_if_none_match: bool = True) -> None:
        self.objects: dict[str, bytes] = {}
        self.calls: list[dict] = []
        self.supports = supports_if_none_match

    def put_object(self, *, Bucket, Key, Body, Metadata=None, **kw):
        if "IfNoneMatch" in kw and not self.supports:
            raise ParamValidationError('Unknown parameter in input: "IfNoneMatch"')
        self.calls.append({"Key": Key, **kw, "Metadata": Metadata})
        data = Body if isinstance(Body, bytes) else Body.read()
        if kw.get("IfNoneMatch") == "*" and Key in self.objects:
            raise _ClientError("PreconditionFailed")
        self.objects[Key] = data

    def get_object(self, *, Bucket, Key):
        return {"Body": io.BytesIO(self.objects[Key])}

    def head_object(self, *, Bucket, Key):
        if Key not in self.objects:
            raise _ClientError("404")
        return {"ContentLength": len(self.objects[Key])}


def _s3(tmp_path, client: FakeS3) -> S3ObjectStore:
    from conftest import make_settings

    s3 = S3ObjectStore(make_settings(tmp_path / "var", object_store="s3", s3_bucket="bucket"))
    s3._import_error, s3._client = None, client
    return s3


def test_s3_put_if_absent_uses_conditional_put_and_verifies(tmp_path):
    client = FakeS3()
    s3 = _s3(tmp_path, client)
    first = s3.put_if_absent("projects/p/bundles/b.json", b'{"research_use_only":true}')
    assert first.created and client.calls[0]["IfNoneMatch"] == "*"
    assert client.calls[0]["Metadata"] == {"sha256": first.sha256}
    src = tmp_path / "same.json"
    src.write_bytes(b'{"research_use_only":true}')
    assert s3.put_if_absent("projects/p/bundles/b.json", src).created is False  # 412 -> verified
    with pytest.raises(ObjectConflictError):
        s3.put_if_absent("projects/p/bundles/b.json", b"{}")
    assert client.objects["projects/p/bundles/b.json"] == b'{"research_use_only":true}'
    key, digest = s3.put_content_addressed("projects/p/checkpoints", io.BytesIO(b"ckpt"), ".npz")
    assert key == f"projects/p/checkpoints/{sha(b'ckpt')}.npz" and client.objects[key] == b"ckpt"


def test_s3_old_client_falls_back_to_head_then_put(tmp_path):
    client = FakeS3(supports_if_none_match=False)
    s3 = _s3(tmp_path, client)
    assert s3.put_if_absent("k/a.bin", b"one").created is True
    assert s3.put_if_absent("k/a.bin", b"one").created is False
    with pytest.raises(ObjectConflictError):
        s3.put_if_absent("k/a.bin", b"two")
    assert client.objects["k/a.bin"] == b"one"
