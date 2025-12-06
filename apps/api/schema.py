from __future__ import annotations

from typing import List

import strawberry

from . import models


@strawberry.type
class WorkspaceType:
    id: strawberry.ID
    name: str
    plan: str


@strawberry.type
class ScenarioStepType:
    id: strawberry.ID
    name: str
    agent: str
    tool: str | None
    input_template: str


@strawberry.type
class ScenarioType:
    id: strawberry.ID
    workspace_id: strawberry.ID
    name: str
    description: str
    guardrails: List[str]
    steps: List[ScenarioStepType]


@strawberry.type
class Query:
    @strawberry.field
    def workspaces(self) -> list[WorkspaceType]:
        # TODO: replace with persistence
        demo = models.Workspace(id="ws_demo", name="Demo Org")
        return [WorkspaceType(id=demo.id, name=demo.name, plan=demo.plan.value)]

    @strawberry.field
    def scenarios(self) -> list[ScenarioType]:
        step = models.ScenarioStep(
            id="step_guardrail",
            name="Guardrail",
            agent="guardrail-agent",
            input_template="{{input}}",
        )
        scenario = models.Scenario(
            id="scn_demo",
            workspace_id="ws_demo",
            name="Incident Playbook",
            description="Demo incident handling flow",
            steps=[step],
        )
        return [
            ScenarioType(
                id=scenario.id,
                workspace_id=scenario.workspace_id,
                name=scenario.name,
                description=scenario.description,
                guardrails=scenario.guardrails,
                steps=[
                    ScenarioStepType(
                        id=step.id,
                        name=step.name,
                        agent=step.agent,
                        tool=step.tool,
                        input_template=step.input_template,
                    )
                ],
            )
        ]


schema = strawberry.Schema(query=Query)
