import asyncio

import pytest

from apps.orchestrator import engine, models


class DummyLLM:
    async def invoke(self, payload):
        await asyncio.sleep(0)
        return {"status": "ok", "output": f"echo:{payload['prompt']}"}


@pytest.mark.asyncio
async def test_runner_executes_steps_in_order():
    runner = engine.ScenarioRunner(llm_client=DummyLLM())
    plan = models.ScenarioPlan(
        id="plan",
        name="Demo",
        steps=[
            models.AgentStep(id="s1", agent="a1", input_template="hello {user}"),
            models.AgentStep(id="s2", agent="a2", input_template="result {s1}"),
        ],
    )

    results = await runner.run(plan, {"user": "BMAD"})

    assert [r.step_id for r in results] == ["s1", "s2"]
    assert results[-1].output.startswith("echo:result echo:")
