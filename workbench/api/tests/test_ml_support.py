"""Shared helpers for the ML tests (this module defines no tests).

The seeded template already contains the ML demo (see dermpath/ml/seed_demo.py): a frozen
workflow-demo dataset with one run per head, and the separate synthetic pipeline-test cohort
project with its frozen dataset and one run per head. Ids are in ``ids["ml_demo"]``.
"""

from __future__ import annotations

PID = "proj-bcc-demo"
CID = "proj-synthetic-cohort"
LEAD = "user-research-lead"
SYNTH = "synthetic-deterministic-v1"
BANNER = "PIPELINE TEST — NOT PATHOLOGY VALIDATION"
FAST = {"n_boot": 200, "max_epochs": 15, "patience": 5, "pixel_mode": "none", "max_patches_per_slide": 32}


def run_jobs(types=("train",)):
    from dermpath.jobs.worker import Worker

    return Worker("ml-test-worker", types=list(types)).run_until_idle()


def start(client, pid: str, dv_id: str, head: str, *, seed: int = 0, params: dict | None = None,
          encoder: str = SYNTH, name: str | None = None) -> dict:
    body = {"dataset_version_id": dv_id, "encoder_id": encoder, "head": head, "seed": seed,
            "params": FAST if params is None else params}
    if name:
        body["name"] = name
    r = client.post(f"/api/v1/projects/{pid}/experiments", json=body)
    assert r.status_code == 202, r.text
    return r.json()


def train(client, pid: str, dv_id: str, head: str, *, seed: int = 0, params: dict | None = None) -> dict:
    out = start(client, pid, dv_id, head, seed=seed, params=params)
    run_jobs()
    run = client.get(f"/api/v1/experiments/{out['experiment']['id']}").json()
    assert run["status"] == "succeeded", run
    return run


def cohort(ids) -> dict:
    assert ids["ml_demo"]["status"] == "succeeded", ids["ml_demo"]
    return ids["ml_demo"]["cohort"]


def workflow(ids) -> dict:
    assert ids["ml_demo"]["status"] == "succeeded", ids["ml_demo"]
    return ids["ml_demo"]["workflow"]


def custom_dataset(pid: str, name: str, assign, *, label_scope: str = "slide") -> str:
    """Freeze a dataset whose patient-grouped split is chosen by ``assign(patient_code, labels) -> split``.

    Splits stay patient-grouped (one split per coded patient); only the grouping rule is custom.
    """
    from dermpath.auth import Actor
    from dermpath.datasets import create_draft, freeze, item_rows
    from dermpath.db import session_scope
    from dermpath.models import Project, SplitAssignment

    lead = Actor(LEAD, "research_lead", "Priya Navarro")
    with session_scope() as db:
        dv = create_draft(db, lead, db.get(Project, pid), name=name,
                          config={"label_scope": label_scope, "eligible_review_states": ["approved"],
                                  "include_provenance": ["demo_synthetic"],
                                  "label_values": ["bcc_present", "bcc_absent_not_benign"]})
        by_patient: dict[str, dict] = {}
        for r in item_rows(db, dv):
            p = by_patient.setdefault(r["coded_patient_id"], {"code": r["patient_code"], "labels": []})
            p["labels"].append(r["label_value"])
        for pid_, p in sorted(by_patient.items()):
            db.add(SplitAssignment(dataset_version_id=dv.id, coded_patient_id=pid_, split=assign(p["code"], p["labels"]),
                                   partition="random"))
        db.flush()
        freeze(db, lead, dv, reason="test dataset", acknowledge_warnings=True)
        return dv.id


def manifest_ids(dv_id: str) -> dict[str, set]:
    from dermpath.db import session_scope
    from dermpath.models import DatasetVersion

    with session_scope() as db:
        m = db.get(DatasetVersion, dv_id).manifest_json
    out: dict[str, set] = {"train": set(), "val": set(), "test": set()}
    for it in m["items"]:
        out[it["split"]].add(it["slide_id"])
    return out
