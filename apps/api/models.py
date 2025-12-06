from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class WorkspacePlan(str, Enum):
    free = "free"
    pro = "pro"
    enterprise = "enterprise"


class Workspace(BaseModel):
    id: str
    name: str
    plan: WorkspacePlan = WorkspacePlan.pro
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class ScenarioStep(BaseModel):
    id: str
    name: str
    agent: str
    tool: str | None = None
    input_template: str


class Scenario(BaseModel):
    id: str
    workspace_id: str
    name: str
    description: str
    steps: list[ScenarioStep]
    guardrails: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class RetrieverSyncJob(BaseModel):
    id: str
    workspace_id: str
    source: str
    schedule_cron: str
    last_run_at: datetime | None = None
    config: dict[str, Any] = Field(default_factory=dict)
