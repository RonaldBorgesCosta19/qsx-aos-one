"""
EventStore Interface - Abstract definition for all event storage implementations.

The EventStore is the single source of truth for all events in QSX-AOS ONE.
It must guarantee:
- Append-only semantics (no updates, no deletes)
- Hash chain integrity (each event links to previous via SHA256)
- Idempotency (same event_id returns existing event, no duplicates)
- Causality preservation (causation_id chain is immutable)
"""

from abc import ABC, abstractmethod
from typing import Optional, List, Dict, Any
from datetime import datetime


class EventStoreException(Exception):
    """Base exception for EventStore errors."""
    pass


class EventNotFoundError(EventStoreException):
    """Event not found in store."""
    pass


class DuplicateEventError(EventStoreException):
    """Attempt to store event with duplicate event_id."""
    pass


class HashChainBrokenError(EventStoreException):
    """Hash chain validation failed."""
    pass


class EventStore(ABC):
    """
    Abstract EventStore interface.
    
    All implementations must provide:
    1. Append-only storage (no mutations)
    2. SHA256 hash chain validation
    3. Idempotency (duplicate detection)
    4. Query capabilities by event_id, correlation_id, causation_id
    5. Replay capability for state reconstruction
    """
    
    @abstractmethod
    def append_event(self, event_dict: Dict[str, Any]) -> str:
        """
        Append event to store.
        
        Args:
            event_dict: Event serialized as dict with metadata, payload, hashes
        
        Returns:
            event_id of the stored event
        
        Raises:
            DuplicateEventError: If event_id already exists
            HashChainBrokenError: If previous_hash doesn't match previous event
        """
        pass
    
    @abstractmethod
    def get_event(self, event_id: str) -> Optional[Dict[str, Any]]:
        """
        Retrieve a single event by ID.
        
        Args:
            event_id: The event to retrieve
        
        Returns:
            Event dict or None if not found
        """
        pass
    
    @abstractmethod
    def get_events_by_correlation_id(
        self, correlation_id: str, limit: int = 1000
    ) -> List[Dict[str, Any]]:
        """
        Get all events with same correlation_id.
        
        Events with same correlation_id are related and form a business transaction.
        
        Args:
            correlation_id: Group identifier
            limit: Max results
        
        Returns:
            List of events in order
        """
        pass
    
    @abstractmethod
    def get_events_by_aggregate_id(
        self, aggregate_id: str, limit: int = 1000
    ) -> List[Dict[str, Any]]:
        """
        Get all events for an aggregate (e.g., symbol or position).
        
        Args:
            aggregate_id: Aggregate identifier (e.g., "BTCUSDT")
            limit: Max results
        
        Returns:
            List of events in order
        """
        pass
    
    @abstractmethod
    def get_events_by_type(
        self, event_type: str, limit: int = 1000
    ) -> List[Dict[str, Any]]:
        """
        Get all events of a specific type.
        
        Args:
            event_type: Event type (e.g., "MarketDataReceived")
            limit: Max results
        
        Returns:
            List of events in order
        """
        pass
    
    @abstractmethod
    def get_events_after_timestamp(
        self, timestamp: str, limit: int = 1000
    ) -> List[Dict[str, Any]]:
        """
        Get all events after a timestamp.
        
        Args:
            timestamp: ISO 8601 timestamp
            limit: Max results
        
        Returns:
            List of events in order
        """
        pass
    
    @abstractmethod
    def get_causation_chain(self, event_id: str) -> List[Dict[str, Any]]:
        """
        Get full causation chain for an event.
        
        Walks backwards through causation_id links to find all ancestors.
        
        Args:
            event_id: Starting event
        
        Returns:
            List of events from root cause to given event_id
        """
        pass
    
    @abstractmethod
    def validate_chain_integrity(self, start_event_id: str = None) -> bool:
        """
        Validate that hash chain is intact.
        
        Recomputes hashes and verifies chain from start_event_id (or from beginning).
        
        Args:
            start_event_id: Optional starting point (default: from first event)
        
        Returns:
            True if chain is valid
        
        Raises:
            HashChainBrokenError: If any hash doesn't match
        """
        pass
    
    @abstractmethod
    def replay_events(
        self, start_event_id: str = None, end_event_id: str = None
    ) -> List[Dict[str, Any]]:
        """
        Get events in order for replay.
        
        Used to reconstruct state from EventStore.
        
        Args:
            start_event_id: Optional start point
            end_event_id: Optional end point
        
        Returns:
            Ordered list of events for replay
        """
        pass
    
    @abstractmethod
    def get_event_count(self) -> int:
        """Get total number of events in store."""
        pass
    
    @abstractmethod
    def get_last_event(self) -> Optional[Dict[str, Any]]:
        """Get the most recent event."""
        pass
    
    @abstractmethod
    def get_last_hash(self) -> Optional[str]:
        """Get the hash of the last event (for chaining new events)."""
        pass
    
    @abstractmethod
    def health_check(self) -> Dict[str, Any]:
        """
        Check EventStore health.
        
        Returns:
            Dict with status, event_count, last_event_id, chain_valid, etc.
        """
        pass
