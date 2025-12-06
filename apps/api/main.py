from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from strawberry.fastapi import GraphQLRouter

from .config import get_settings
from .routes import scenarios, workspaces
from .schema import schema

settings = get_settings()
app = FastAPI(title="BMAD API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(workspaces.router)
app.include_router(scenarios.router)

graphql_app = GraphQLRouter(schema)
app.include_router(graphql_app, prefix="/graphql")


@app.get("/healthz")
async def healthcheck() -> dict[str, str]:
    return {"status": "ok"}
