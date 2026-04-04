from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


ROOT_DIR = Path(__file__).resolve().parents[2]
BACKEND_DIR = ROOT_DIR / "backend"
DEFAULT_DB_PATH = BACKEND_DIR / "data" / "app.db"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(ROOT_DIR / ".env", BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "Gazabot Guardian API"
    environment: str = "development"
    database_url: str = f"sqlite:///{DEFAULT_DB_PATH}"
    allowed_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    browser_use_api_key: str | None = None
    browser_use_base_url: str = "https://api.browser-use.com/api/v3"
    browser_use_model: str = "bu-mini"
    browser_use_profile_id: str | None = None
    browser_use_proxy_country_code: str | None = "us"
    browser_use_max_cost_usd: float = 0.5
    browser_use_keep_alive: bool = True
    browser_use_idle_stop_seconds: int = 90
    browser_use_mock_mode: bool = True

    @field_validator("allowed_origins", mode="before")
    @classmethod
    def parse_allowed_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [item.strip() for item in value.split(",") if item.strip()]
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()


def reset_settings_cache() -> None:
    get_settings.cache_clear()
