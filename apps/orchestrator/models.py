from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass
class ToolCall:
    name: str
    args: dict[str, Any] = field(default_factory=dict)


@dataclass
class AgentStep:
    id: str
    agent: str
    input_template: str
    tool: ToolCall | None = None


@dataclass
class ScenarioPlan:
    id: str
    name: str
    steps: list[AgentStep]


@dataclass
class ExecutionResult:
    step_id: str
    output: Any
    latency_ms: int
    error: str | None = None


Observer = Callable[[ExecutionResult], None]
