from __future__ import annotations

import asyncio
import time
from typing import Any

from tenacity import AsyncRetrying, retry_if_exception_type, stop_after_attempt, wait_exponential

from . import models


class LLMError(Exception):
    """Raised when the LLM/tool call fails."""


class ScenarioRunner:
    def __init__(self, llm_client: Any, observer: models.Observer | None = None):
        self.llm_client = llm_client
        self.observer = observer

    async def run(self, plan: models.ScenarioPlan, context: dict[str, Any]) -> list[models.ExecutionResult]:
        results: list[models.ExecutionResult] = []
        for step in plan.steps:
            result = await self._execute_step(step, context)
            results.append(result)
            context[step.id] = result.output
            if self.observer:
                self.observer(result)
        return results

    async def _execute_step(self, step: models.AgentStep, context: dict[str, Any]) -> models.ExecutionResult:
        template = step.input_template.format(**context)
        start = time.perf_counter()

        async for attempt in AsyncRetrying(
            retry=retry_if_exception_type(LLMError),
            wait=wait_exponential(multiplier=0.5, min=0.5, max=5),
            stop=stop_after_attempt(3),
        ):
            with attempt:
                output = await self._call_llm(step.agent, template, step.tool)

        latency_ms = int((time.perf_counter() - start) * 1000)
        return models.ExecutionResult(step_id=step.id, output=output, latency_ms=latency_ms)

    async def _call_llm(self, agent: str, prompt: str, tool: models.ToolCall | None) -> Any:
        """LLM呼び出し + 必要に応じてツールを連携"""
        if not hasattr(self.llm_client, "invoke"):
            raise LLMError("llm_client missing invoke()")

        payload = {"agent": agent, "prompt": prompt}
        if tool:
            payload["tool"] = {"name": tool.name, "args": tool.args}

        response = await self.llm_client.invoke(payload)
        if response.get("status") != "ok":
            raise LLMError(response.get("error", "unknown error"))
        return response["output"]


class ConsoleObserver:
    def __call__(self, result: models.ExecutionResult) -> None:
        print(
            f"[ScenarioRunner] step={result.step_id} latency={result.latency_ms}ms error={result.error}"
        )
