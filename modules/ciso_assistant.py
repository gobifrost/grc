"""
CISO Assistant API client.

Authentication
--------------
CISO Assistant accepts Django token auth. Public docs show both PAT usage and
username/password login:
  - Header: Authorization: Token <token>
  - Login:  POST /api/iam/login/

Required Config (Bifrost integration "CISO Assistant")
------------------------------------------------------
- base_url
- pat: Personal access token. Preferred.

Fallback Config
---------------
- username
- password

The configured base_url may be either the instance root or the /api root.
"""

from __future__ import annotations

import logging
from typing import Any
from urllib.parse import urljoin

import httpx

logger = logging.getLogger(__name__)

_MAX_PAGE_GUARD = 25


def _normalize_api_url(base_url: str) -> str:
    base = (base_url or "").strip().rstrip("/") + "/"
    if not base:
        raise ValueError("base_url is required")
    if not base.rstrip("/").endswith("/api"):
        base = urljoin(base, "api/")
    return base


def _extract_token(data: Any) -> str | None:
    if not isinstance(data, dict):
        return None
    for key in ("token", "key", "auth_token"):
        value = data.get(key)
        if isinstance(value, str) and value:
            return value
    nested = data.get("data")
    if isinstance(nested, dict):
        return _extract_token(nested)
    return None


class CISOAssistantClient:
    """Small async REST client for CISO Assistant."""

    def __init__(
        self,
        *,
        base_url: str,
        username: str | None = None,
        password: str | None = None,
        token: str | None = None,
        timeout: float = 30.0,
    ):
        self.base_url = _normalize_api_url(base_url)
        self.username = username
        self.password = password
        self._token = token
        self._http: httpx.AsyncClient | None = None
        self._timeout = timeout

    async def __aenter__(self) -> "CISOAssistantClient":
        await self._get_http()
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.close()

    async def _get_http(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(
                timeout=self._timeout,
                headers={
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                    "User-Agent": "Bifrost/1.0",
                },
            )
        return self._http

    async def close(self) -> None:
        if self._http:
            await self._http.aclose()
            self._http = None

    def _url(self, path: str) -> str:
        clean = path.strip("/")
        return urljoin(self.base_url, f"{clean}/")

    async def login(self) -> str:
        if self._token:
            return self._token
        if not self.username or not self.password:
            raise RuntimeError("CISO Assistant username/password or token is required")

        http = await self._get_http()
        response = await http.post(
            self._url("iam/login"),
            json={"username": self.username, "password": self.password},
        )
        if response.status_code >= 400:
            logger.error("CISO Assistant login failed: %s %s", response.status_code, response.text[:500])
            response.raise_for_status()

        data = response.json() if response.content else {}
        token = _extract_token(data)
        if not token:
            raise RuntimeError(f"CISO Assistant login returned no token. Keys: {sorted(data.keys())}")
        self._token = token
        return token

    async def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: Any = None,
        authenticate: bool = True,
    ) -> Any:
        http = await self._get_http()
        headers: dict[str, str] = {}
        if authenticate:
            headers["Authorization"] = f"Token {await self.login()}"

        response = await http.request(
            method.upper(),
            self._url(path),
            params=params,
            json=json,
            headers=headers,
        )
        if response.status_code >= 400:
            logger.error(
                "CISO Assistant %s %s failed: %s %s",
                method.upper(),
                path,
                response.status_code,
                response.text[:500],
            )
            response.raise_for_status()
        return response.json() if response.content else None

    async def get(self, path: str, *, params: dict[str, Any] | None = None) -> Any:
        return await self.request("GET", path, params=params)

    async def post(self, path: str, *, json: Any = None) -> Any:
        return await self.request("POST", path, json=json)

    async def patch(self, path: str, *, json: Any = None) -> Any:
        return await self.request("PATCH", path, json=json)

    async def current_user(self) -> dict[str, Any]:
        data = await self.get("iam/current-user")
        return data if isinstance(data, dict) else {"value": data}

    async def list_resource(
        self,
        resource: str,
        *,
        params: dict[str, Any] | None = None,
        page_limit: int = _MAX_PAGE_GUARD,
    ) -> list[Any]:
        """List a DRF resource, following `next` pagination when present."""
        items: list[Any] = []
        next_url: str | None = None
        page = 0
        query = params or {}

        while page < page_limit:
            http = await self._get_http()
            headers = {"Authorization": f"Token {await self.login()}"}
            if next_url:
                response = await http.get(next_url, headers=headers)
                if response.status_code >= 400:
                    response.raise_for_status()
                data = response.json() if response.content else {}
            else:
                data = await self.get(resource, params=query)

            if isinstance(data, list):
                items.extend(data)
                break
            if not isinstance(data, dict):
                break

            results = data.get("results")
            if isinstance(results, list):
                items.extend(results)
            else:
                items.append(data)
                break

            next_value = data.get("next")
            next_url = next_value if isinstance(next_value, str) and next_value else None
            if not next_url:
                break
            page += 1

        return items

    async def probe(self) -> dict[str, Any]:
        """Sanitized connectivity probe for migration discovery."""
        user = await self.current_user()
        resources = {}
        for resource in (
            "frameworks",
            "loaded-libraries",
            "compliance-assessments",
            "requirement-assessments",
            "reference-controls",
            "risk-assessments",
            "risk-scenarios",
            "security-exceptions",
            "findings",
            "evidences",
        ):
            try:
                rows = await self.list_resource(resource, params={"page_size": 1}, page_limit=1)
                resources[resource] = {
                    "reachable": True,
                    "sample_count": len(rows),
                    "sample_keys": sorted(rows[0].keys())[:30] if rows and isinstance(rows[0], dict) else [],
                }
            except Exception as exc:  # noqa: BLE001 - probe should report all endpoint failures
                resources[resource] = {
                    "reachable": False,
                    "error": type(exc).__name__,
                    "message": str(exc)[:300],
                }
        return {
            "base_url": self.base_url,
            "authenticated": True,
            "current_user_keys": sorted(user.keys()),
            "resources": resources,
        }


async def get_client(scope: str | None = "global") -> CISOAssistantClient:
    """Build a CISO Assistant client from the Bifrost integration config."""
    from bifrost import integrations

    integration = await integrations.get("CISO Assistant", scope=scope)
    if not integration and scope != "global":
        integration = await integrations.get("CISO Assistant", scope="global")
    if not integration:
        raise RuntimeError(
            "'CISO Assistant' integration not found. Set it up with base_url and pat, "
            "or username/password as a fallback."
        )

    cfg = integration.config or {}
    defaults = getattr(integration, "config_defaults", None) or {}
    merged = {**defaults, **cfg}
    missing = [key for key in ("base_url",) if not merged.get(key)]
    has_pat = bool(merged.get("pat"))
    has_login = bool(merged.get("username") and merged.get("password"))
    if not has_pat and not has_login:
        missing.append("pat or username/password")
    if missing:
        raise RuntimeError(f"'CISO Assistant' integration is missing config keys: {', '.join(missing)}")

    return CISOAssistantClient(
        base_url=merged["base_url"],
        username=merged.get("username"),
        password=merged.get("password"),
        token=merged.get("pat"),
    )
