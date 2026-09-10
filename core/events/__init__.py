"""Events module - Event definitions and base classes."""

from core.events.base import BaseEvent, EventMetadata, create_event
from core.events.definitions import (
    CANONICAL_EVENTS,
    get_event_schema,
    is_canonical_event,
    list_canonical_events,
    get_canonical_event_info,
)

__all__ = [
    "BaseEvent",
    "EventMetadata",
    "create_event",
    "CANONICAL_EVENTS",
    "get_event_schema",
    "is_canonical_event",
    "list_canonical_events",
    "get_canonical_event_info",
]
