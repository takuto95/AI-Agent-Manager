from pydantic import BaseSettings, Field


class Settings(BaseSettings):
    postgres_dsn: str = Field(
        default="postgresql+psycopg://postgres:postgres@localhost:5432/bmad",
        description="Database DSN for workspace metadata storage",
    )
    redis_url: str = Field(default="redis://localhost:6379/0")
    allow_origins: list[str] = Field(default_factory=lambda: ["*"])
    openai_api_key: str | None = None
    anthropic_api_key: str | None = None

    class Config:
        env_file = ".env"
        env_prefix = "BMAD_"


def get_settings() -> Settings:
    return Settings()
