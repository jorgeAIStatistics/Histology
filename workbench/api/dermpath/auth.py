"""Demo session cookies, the role/permission matrix and project-scope guards.

DEMO MODE ONLY: ``POST /auth/demo-login`` lets anyone pick a seeded fictional user.
That is a demo role switch, NOT authentication. Secured mode (OIDC) is not implemented
and fails closed (see :mod:`dermpath.config`).

Every project-scoped route depends on :func:`project_scope` or :func:`entity_scope`,
which (1) require a valid session, (2) require membership of the entity's project and
(3) require the caller's role to hold the route's permission. Reads are guarded too.
"""

from __future__ import annotations

import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from fastapi import Depends, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import get_settings
from .db import get_db
from .errors import ApiError, forbidden, not_found
from .models import Project, ProjectMember, User
from .signing import TokenError, sign, verify

SESSION_COOKIE = "wb_session"
SESSION_CONTEXT = "session"
DEMO_NOTICE = (
    "Demo role switch, not authentication. Anyone with access to this demo can act as any "
    "seeded fictional user. Do not use with real patient data."
)

_ALL_READERS = ("histology_assistant", "pathologist", "research_lead", "medical_director")

#: permission → roles allowed (inside a project the user is a member of).
PERMISSIONS: dict[str, tuple[str, ...]] = {
    "project.view": _ALL_READERS + ("admin",),
    "members.read": _ALL_READERS + ("admin",),
    "members.manage": ("admin",),
    "project.settings": ("research_lead",),
    "workflow_stats.read": _ALL_READERS,
    "hierarchy.read": _ALL_READERS,
    "hierarchy.write": ("histology_assistant",),
    "slide.view_pixels": _ALL_READERS,
    "upload.write": ("histology_assistant",),
    "qc.read": _ALL_READERS,
    "qc.write": ("histology_assistant", "pathologist"),
    "qc.screen": ("histology_assistant", "pathologist"),
    "annotation.read": _ALL_READERS,
    "annotation.write": ("pathologist",),
    "label.read": _ALL_READERS,
    "label.expert_write": ("pathologist",),
    "review.assess": ("pathologist",),
    "review.suggestion": ("pathologist",),
    "review.state.route": ("histology_assistant", "pathologist"),
    "review.state.decide": ("pathologist",),
    "disagreement.read": _ALL_READERS,
    "disagreement.adjudicate": ("pathologist",),
    "near_duplicate.review": ("pathologist", "research_lead"),
    "dataset.read": _ALL_READERS,
    "dataset.write": ("research_lead",),
    "dataset.test_access": ("research_lead",),
    "comment.read": _ALL_READERS,
    "comment.write": _ALL_READERS,  # the medical director's only write
    "jobs.read": _ALL_READERS,
    "jobs.manage": ("histology_assistant", "pathologist", "research_lead"),
    "audit.read": ("research_lead", "medical_director", "admin"),
    # Reserved for the ML pass (experiments, evaluations, research model registry).
    "experiment.read": ("research_lead", "medical_director", "pathologist"),
    "experiment.write": ("research_lead",),
    "model.register": ("research_lead",),
}


def role_has(role: str, permission: str) -> bool:
    return role in PERMISSIONS.get(permission, ())


@dataclass(frozen=True)
class Actor:
    id: str
    role: str
    display_name: str


@dataclass
class Scope:
    actor: Actor
    project_id: str
    obj: Any
    member: ProjectMember


# --------------------------------------------------------------------------- sessions


def issue_session(response: Response, user: User) -> str:
    settings = get_settings()
    now = int(time.time())
    token = sign(
        {"uid": user.id, "iat": now, "exp": now + settings.session_ttl_seconds, "n": secrets.token_hex(8)},
        SESSION_CONTEXT,
    )
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=settings.session_ttl_seconds,
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
        path="/",
    )
    return token


def clear_session(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/", httponly=True, samesite="lax")


def actor_from_request(request: Request, db: Session) -> Actor | None:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    try:
        payload = verify(token, SESSION_CONTEXT)
    except TokenError:
        return None
    user = db.get(User, payload.get("uid"))
    if user is None or not user.active:
        return None
    return Actor(id=user.id, role=user.role, display_name=user.display_name)


def current_actor(request: Request, db: Session = Depends(get_db)) -> Actor:
    actor = actor_from_request(request, db)
    if actor is None:
        raise ApiError(401, "unauthenticated", "Sign in with a demo user first (demo role switch)")
    request.state.actor = actor
    return actor


def require_role(actor: Actor, *roles: str) -> None:
    if actor.role not in roles:
        raise forbidden("role_forbidden", f"Role {actor.role} cannot perform this action", allowed=list(roles))


# --------------------------------------------------------------------------- project guards


def membership(db: Session, actor: Actor, project_id: str) -> ProjectMember | None:
    return db.scalars(
        select(ProjectMember).where(
            ProjectMember.project_id == project_id, ProjectMember.user_id == actor.id
        )
    ).first()


def authorize(db: Session, actor: Actor, project_id: str, permission: str) -> ProjectMember:
    if permission not in PERMISSIONS:
        raise RuntimeError(f"unknown permission {permission}")
    member = membership(db, actor, project_id)
    if member is None:
        raise forbidden("not_project_member", "You are not a member of this project", project_id=project_id)
    if not role_has(actor.role, permission):
        raise forbidden(
            "role_forbidden",
            f"Role {actor.role} lacks permission {permission}",
            permission=permission,
            allowed_roles=list(PERMISSIONS[permission]),
        )
    return member


def project_scope(permission: str, param: str = "pid") -> Callable[..., Scope]:
    """Dependency for routes whose path holds a project id."""

    def dep(request: Request, actor: Actor = Depends(current_actor), db: Session = Depends(get_db)) -> Scope:
        pid = request.path_params.get(param)
        project = db.get(Project, pid) if pid else None
        if project is None:
            raise not_found("project", pid)
        member = authorize(db, actor, project.id, permission)
        return Scope(actor=actor, project_id=project.id, obj=project, member=member)

    dep.__name__ = f"project_scope_{permission.replace('.', '_')}"
    return dep


def entity_scope(
    permission: str,
    model: type | Callable[[Session, str], Any],
    param: str = "id",
    entity_name: str | None = None,
) -> Callable[..., Scope]:
    """Dependency for routes whose path holds an entity id; the entity's project is checked.

    ``model`` is either a mapped class with a ``project_id`` column (looked up by primary
    key) or a resolver ``(db, raw_id) -> entity | None``.
    """

    name = entity_name or (model.__name__ if isinstance(model, type) else "entity")

    def dep(request: Request, actor: Actor = Depends(current_actor), db: Session = Depends(get_db)) -> Scope:
        raw = request.path_params.get(param)
        obj = None
        if raw:
            obj = db.get(model, raw) if isinstance(model, type) else model(db, raw)
        if obj is None:
            raise not_found(name, raw)
        project_id = getattr(obj, "project_id", None)
        if project_id is None:
            raise not_found(name, raw)
        member = authorize(db, actor, project_id, permission)
        return Scope(actor=actor, project_id=project_id, obj=obj, member=member)

    dep.__name__ = f"entity_scope_{name}_{permission.replace('.', '_')}"
    return dep


def project_ids_for(db: Session, actor: Actor) -> list[str]:
    return list(db.scalars(select(ProjectMember.project_id).where(ProjectMember.user_id == actor.id)))
