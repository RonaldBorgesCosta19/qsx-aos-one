"""
__init__.py - Core module initialization
"""

# Event system
from core.events.base import BaseEvent, EventMetadata, create_event
from core.events.definitions import (
    CANONICAL_EVENTS,
    get_event_schema,
    is_canonical_event,
    list_canonical_events,
)

# Event Store
from core.event_store.storage import EventStore, EventStoreException, HashChainBrokenError
from core.event_store.memory_store import InMemoryEventStore

# State Engine
from core.state_engine.projections import StateEngine

__all__ = [
    # Events
    "BaseEvent",
    "EventMetadata",
    "create_event",
    "CANONICAL_EVENTS",
    "get_event_schema",
    "is_canonical_event",
    "list_canonical_events",
    # EventStore
    "EventStore",
    "EventStoreException",
    "HashChainBrokenError",
    "InMemoryEventStore",
    # StateEngine
    "StateEngine",
]
