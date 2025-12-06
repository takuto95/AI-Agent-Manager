from __future__ import annotations

from fastapi import APIRouter

from .. import models

router = APIRouter(prefix="/workspaces", tags=["workspaces"])


@router.get("", response_model=list[models.Workspace])
async def list_workspaces() -> list[models.Workspace]:
    # TODO: storage backend
    return [models.Workspace(id="ws_demo", name="Demo Org")]


@router.post("", response_model=models.Workspace, status_code=201)
async def create_workspace(payload: models.Workspace) -> models.Workspace:
    # TODO: persist workspace
    return payload
