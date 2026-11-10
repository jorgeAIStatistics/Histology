"""Acceptance 10: missing model weights give an honest dependency state; nothing is downloaded;
no other encoder is substituted under the same name.

These tests hold whether or not the optional model libraries (timm, torchvision, transformers)
are installed: the expected status is computed from what is importable here.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import socket
import subprocess
import sys
import urllib.request
from pathlib import Path

import pytest
from sqlalchemy import func, select

from test_ml_support import BANNER, CID, LEAD, cohort, run_jobs

API_DIR = Path(__file__).resolve().parent.parent
ENCODER_ENV = ("WB_UNI_WEIGHTS", "WB_UNI_LICENSE_ACCEPTED", "WB_UNI_WEIGHTS_SHA256", "WB_RESNET18_WEIGHTS",
               "WB_RESNET18_WEIGHTS_SHA256", "WB_MIDNIGHT_WEIGHTS", "WB_MIDNIGHT_WEIGHTS_SHA256", "WB_HIBOU_B_WEIGHTS",
               "WB_HIBOU_B_LICENSE_ACCEPTED", "WB_HIBOU_B_WEIGHTS_SHA256")


def _installed(module: str) -> bool:
    return importlib.util.find_spec(module) is not None


@pytest.fixture(autouse=True)
def _clean_encoder_env(monkeypatch):
    for name in ENCODER_ENV:
        monkeypatch.delenv(name, raising=False)


@pytest.fixture()
def no_network(monkeypatch):
    """Every outbound connection attempt is recorded and refused."""
    attempts: list = []

    def refuse(*args, **kwargs):
        attempts.append(args[1:] if args else kwargs)
        raise OSError("network disabled in this test")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket.socket, "connect_ex", refuse)
    monkeypatch.setattr(socket, "create_connection", lambda *a, **k: refuse(None, *a))
    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **k: refuse(None, *a))
    return attempts


def _enc(client, encoder_id):
    items = {e["id"]: e for e in client.get("/api/v1/encoders").json()["items"]}
    return items[encoder_id]


def test_encoder_listing_has_licences_and_honest_status(clients, no_network):
    c = clients("user-director")  # any signed-in user can see the encoder catalogue
    body = c.get("/api/v1/encoders").json()
    items = {e["id"]: e for e in body["items"]}
    assert set(items) >= {"synthetic-deterministic-v1", "handcrafted-stain-texture-v1", "uni-v1", "midnight-12k",
                          "hibou-b", "generic-imagenet-resnet18"}
    for e in items.values():  # every entry carries its frozen spec
        assert len(e["spec_sha256"]) == 64 and isinstance(e["official_reference"], dict)
        assert {"adapter_version", "architecture", "input_size", "mean", "std", "pooling"} <= set(e)
    syn = items["synthetic-deterministic-v1"]
    assert syn["status"] == "available" and syn["kind"] == "synthetic" and syn["synthetic"] is True
    assert syn["banner"] == BANNER and "NO pathology information" in syn["notice"] and syn["reads_pixels"] is False
    hc = items["handcrafted-stain-texture-v1"]
    assert hc["status"] == "available" and hc["kind"] == "handcrafted" and hc["reads_pixels"] is True
    assert hc["synthetic"] is False and hc["banner"] is None and "NOT a pathology foundation model" in hc["notice"]
    assert hc["weights_sha256"].startswith("handcrafted:1:") and hc["embedding_dim"] == 64
    uni = items["uni-v1"]
    assert uni["kind"] == "pathology_foundation" and uni["synthetic"] is False
    assert uni["license"]["name"].startswith("CC-BY-NC-ND 4.0") and uni["license"]["commercial_use"] == "no"
    assert uni["status"] == "missing_weights" and uni["weights_sha256"] is None
    for needle in ("WB_UNI_WEIGHTS", "WB_UNI_LICENSE_ACCEPTED=1", "pytorch_model.bin", "Nothing is downloaded"):
        assert needle in uni["status_detail"], needle
    assert uni["official_reference"]["model_card"] == "https://huggingface.co/MahmoodLab/UNI"
    assert uni["architecture"]["kwargs"] == {"img_size": 224, "patch_size": 16, "init_values": 1e-5,
                                             "num_classes": 0, "dynamic_img_size": True}
    mid = items["midnight-12k"]
    assert mid["status"] == "missing_weights" and mid["license"]["name"] == "MIT" and mid["embedding_dim"] == 3072
    assert "WB_MIDNIGHT_WEIGHTS is not set" in mid["status_detail"] and "model.safetensors" in mid["status_detail"]
    hib = items["hibou-b"]
    assert hib["status"] == "missing_weights" and "UNVERIFIED" in hib["notice"]
    for needle in ("WB_HIBOU_B_WEIGHTS is not set", "WB_HIBOU_B_LICENSE_ACCEPTED=1 is not set", "Nothing is downloaded"):
        assert needle in hib["status_detail"], needle
    res = items["generic-imagenet-resnet18"]
    assert res["kind"] == "generic_imagenet" and "NOT a pathology model" in res["name"]
    # Weights are reported missing first; a missing library is listed in the same detail.
    assert res["status"] == "missing_weights" and "WB_RESNET18_WEIGHTS is not set" in res["status_detail"]
    assert ("'torchvision' is not installed" in res["status_detail"]) is (not _installed("torchvision"))
    assert clients.anon().get("/api/v1/encoders").status_code == 401
    assert no_network == []


def test_uni_states_progress_honestly_and_never_fall_back(clients, monkeypatch, tmp_path, no_network):
    lead = clients(LEAD)
    fake = tmp_path / "pytorch_model.bin"
    fake.write_bytes(b"not real weights; never loaded")
    monkeypatch.setenv("WB_UNI_WEIGHTS", str(tmp_path / "missing.bin"))
    u = _enc(lead, "uni-v1")
    assert u["status"] == "missing_weights" and "does not exist" in u["status_detail"]
    monkeypatch.setenv("WB_UNI_WEIGHTS", str(fake))
    u = _enc(lead, "uni-v1")
    assert u["status"] == "missing_weights" and "WB_UNI_LICENSE_ACCEPTED=1 is not set" in u["status_detail"]
    monkeypatch.setenv("WB_UNI_LICENSE_ACCEPTED", "1")
    u = _enc(lead, "uni-v1")
    assert str(fake) in u["status_detail"] and "Nothing is downloaded" in u["status_detail"]
    if not _installed("timm"):
        # Weights and licence present, but the architecture library is not installed here.
        assert u["status"] == "missing_dependency" and "'timm'" in u["status_detail"]
    else:
        # The library is present, but the file is not a checkpoint: refused, never loaded or substituted.
        assert u["status"] == "weights_mismatch" and "not a PyTorch checkpoint" in u["status_detail"]
        assert u["weights_sha256"] == hashlib.sha256(fake.read_bytes()).hexdigest()  # what is there, reported
    assert no_network == []


def test_experiment_with_unavailable_uni_is_refused_409(clients, ids, monkeypatch, no_network):
    monkeypatch.delenv("WB_UNI_WEIGHTS", raising=False)
    lead = clients(LEAD)
    dv = cohort(ids)["dataset_version_id"]
    r = lead.post(f"/api/v1/projects/{CID}/experiments", json={"dataset_version_id": dv, "encoder_id": "uni-v1",
                                                               "head": "abmil", "seed": 0})
    assert r.status_code == 409
    err = r.json()["error"]
    assert err["code"] == "encoder_unavailable" and err["details"]["status"] == "missing_weights"
    assert "WB_UNI_WEIGHTS" in err["details"]["status_detail"]
    assert lead.post(f"/api/v1/projects/{CID}/experiments", json={
        "dataset_version_id": dv, "encoder_id": "generic-imagenet-resnet18", "head": "abmil", "seed": 0}
    ).json()["error"]["code"] == "encoder_unavailable"
    assert no_network == []


def test_worker_refuses_a_uni_run_and_never_substitutes(clients, ids, monkeypatch, no_network):
    """Even if a uni-v1 run row exists (e.g. weights removed after it was queued), the job fails
    permanently with the dependency state; no embedding is produced under that name."""
    monkeypatch.delenv("WB_UNI_WEIGHTS", raising=False)
    from dermpath.auth import Actor
    from dermpath.db import session_scope
    from dermpath.jobs import queue
    from dermpath.ml.models import FeatureArtifact, TrainingRun
    from dermpath.models import DatasetVersion, Job

    dv_id = cohort(ids)["dataset_version_id"]
    with session_scope() as db:
        dv = db.get(DatasetVersion, dv_id)
        run = TrainingRun(project_id=CID, name="uni attempt", dataset_version_id=dv_id,
                          dataset_manifest_sha256=dv.manifest_sha256, encoder_id="uni-v1", head="abmil",
                          params_json={}, seed=0, status="queued", synthetic=False, label_scope="slide",
                          positive_class="bcc_present", negative_class="bcc_absent_not_benign",
                          created_by=Actor(LEAD, "research_lead", "x").id)
        db.add(run)
        db.flush()
        job, _ = queue.enqueue(db, "train", {"run_id": run.id}, idempotency_key=f"train:{run.id}", project_id=CID)
        run.job_id, rid, jid = job.id, run.id, job.id
    outcomes = run_jobs()
    assert [o.status for o in outcomes] == ["failed"]
    with session_scope() as db:
        assert "encoder_unavailable" in db.get(Job, jid).error and db.get(Job, jid).attempts == 1
        assert db.scalar(select(func.count(FeatureArtifact.id)).where(FeatureArtifact.encoder_id == "uni-v1")) == 0
    run = clients(LEAD).get(f"/api/v1/experiments/{rid}").json()
    assert run["status"] == "failed" and "missing_weights" in run["error"] and run["checkpoint"] is None
    assert no_network == []


def test_no_hub_or_download_client_is_imported():
    """Importing the ML modules pulls in no model or hub library (checked in a fresh interpreter,
    because other tests in this session legitimately import them), and the encoder sources
    contain no download path."""
    code = ("import json, sys\n"
            "import dermpath.ml.encoders, dermpath.ml.router, dermpath.ml.training\n"
            "print(json.dumps(sorted(m for m in ('huggingface_hub', 'timm', 'torchvision', 'transformers', "
            "'safetensors') if m in sys.modules)))\n")
    out = subprocess.run([sys.executable, "-c", code], cwd=API_DIR, capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    assert json.loads(out.stdout.strip().splitlines()[-1]) == []

    from dermpath.ml import devices, encoders, fixture, handcrafted

    src = Path(encoders.__file__).read_text()
    assert "pretrained=False" in src
    for module in (encoders, devices, fixture, handcrafted):
        text = Path(module.__file__).read_text()
        for forbidden in ("hf_hub_download", "snapshot_download", "from_pretrained", "load_state_dict_from_url",
                          "urlopen", "import requests", "pretrained=True", "trust_remote_code=True"):
            assert forbidden not in text, (module.__name__, forbidden)
