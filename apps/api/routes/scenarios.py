from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import models

router = APIRouter(prefix="/scenarios", tags=["scenarios"])


_demo_scenario = models.Scenario(
    id="scn_demo",
    workspace_id="ws_demo",
    name="Incident Playbook",
    description="Demo incident flow",
    steps=[
        models.ScenarioStep(
            id="step_guardrail",
            name="Guardrail",
            agent="guardrail-agent",
            input_template="{{input}}",
        )
    ],
)


@router.get("", response_model=list[models.Scenario])
async def list_scenarios() -> list[models.Scenario]:
    return [_demo_scenario]


@router.get("/{scenario_id}", response_model=models.Scenario)
async def get_scenario(scenario_id: str) -> models.Scenario:
    if scenario_id != _demo_scenario.id:
        raise HTTPException(status_code=404, detail="Scenario not found")
    return _demo_scenario
