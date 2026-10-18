"""The one error type handlers raise; it becomes `{ "error": { code, message, … } }`."""

from __future__ import annotations

from typing import Dict, Optional


class ApiError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        field: Optional[str] = None,
        reason: Optional[str] = None,
        headers: Optional[Dict[str, str]] = None,
        extra: Optional[Dict[str, object]] = None,
    ):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.field = field
        self.reason = reason
        self.headers = headers or {}
        self.extra = extra or {}  # code-specific fields, e.g. the existing id of a duplicate

    def body(self) -> dict:
        error = {"code": self.code, "message": self.message}
        if self.field is not None:
            error["field"] = self.field
        if self.reason is not None:
            error["reason"] = self.reason
        error.update(self.extra)
        return {"error": error}


def validation(message: str, field: Optional[str] = None) -> ApiError:
    return ApiError(400, "validation_error", message, field=field)


def not_found(what: str = "Not found") -> ApiError:
    return ApiError(404, "not_found", what)


def unauthorized(message: str = "Sign-in required") -> ApiError:
    return ApiError(401, "unauthorized", message, headers={"WWW-Authenticate": "Bearer"})


def forbidden(message: str = "Only the author can do this") -> ApiError:
    return ApiError(403, "forbidden", message)


def deleted(message: str = "This item was deleted by its author") -> ApiError:
    return ApiError(409, "deleted", message)
