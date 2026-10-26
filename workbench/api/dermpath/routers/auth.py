"""Auth routes (demo mode only): demo login, logout, me, demo users."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import audit
from ..auth import (
    DEMO_NOTICE,
    PERMISSIONS,
    Actor,
    actor_from_request,
    clear_session,
    current_actor,
    issue_session,
)
from ..config import get_settings
from ..db import get_db
from ..errors import ApiError
from ..models import Project, ProjectMember, User
from ..schemas import DemoLoginIn, MeOut, UserOut

router = APIRouter(prefix="/auth", tags=["auth"])


def user_dict(u: User) -> dict:
    return {"id": u.id, "display_name": u.display_name, "role": u.role, "active": u.active,
            "demo_user": u.demo_user, "fictional": u.demo_user}


@router.get("/demo-users", response_model=list[UserOut])
def demo_users(db: Session = Depends(get_db)):
    """Seeded fictional users for the demo role switch (demo mode only)."""
    users = db.scalars(select(User).where(User.demo_user.is_(True), User.active.is_(True)).order_by(User.id)).all()
    return [user_dict(u) for u in users]


@router.post("/demo-login", response_model=MeOut)
def demo_login(body: DemoLoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    """Issue an HMAC-signed HttpOnly SameSite=Lax session cookie for a seeded fictional user.
    This is a demo role switch, NOT authentication."""
    user = db.get(User, body.user_id)
    if user is None or not user.active or not user.demo_user:
        raise ApiError(404, "unknown_demo_user", "No such seeded demo user")
    issue_session(response, user)
    actor = Actor(id=user.id, role=user.role, display_name=user.display_name)
    audit.record_for(db, actor, project_id=None, action="auth.demo_login", entity_type="user", entity_id=user.id,
                     after={"role": user.role, "mode": "demo"})
    db.commit()
    return _me(db, user)


@router.post("/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    actor = actor_from_request(request, db)
    clear_session(response)
    if actor is not None:
        audit.record_for(db, actor, project_id=None, action="auth.logout", entity_type="user", entity_id=actor.id)
        db.commit()
    return {"ok": True}


def _me(db: Session, user: User) -> dict:
    rows = db.execute(select(ProjectMember, Project).join(Project, Project.id == ProjectMember.project_id)
                      .where(ProjectMember.user_id == user.id).order_by(Project.name)).all()
    return {
        "user": user_dict(user),
        "mode": get_settings().mode,
        "authentication": "none (demo role switch)",
        "notice": DEMO_NOTICE,
        "memberships": [{"project_id": p.id, "project_name": p.name, "independent_review": m.independent_review}
                        for m, p in rows],
        "permissions": {perm: list(roles) for perm, roles in PERMISSIONS.items() if user.role in roles},
    }


@router.get("/me", response_model=MeOut)
def me(actor: Actor = Depends(current_actor), db: Session = Depends(get_db)):
    """The current demo user. States explicitly: demo role switch, not authentication."""
    return _me(db, db.get(User, actor.id))
