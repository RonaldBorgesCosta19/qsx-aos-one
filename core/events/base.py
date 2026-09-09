"""
Base Event and EventMetadata classes for the QSX-AOS ONE event-sourced architecture.

Every event in the system carries:
- Identity: event_id (UUID), event_type
- Causality: correlation_id, causation_id
- Integrity: previous_hash, event_hash (SHA256 chain)
- Versioning: schema_version
- Traceability: source, aggregate_id
"""

import json
import hashlib
import uuid
from typing import Optional, Dict, Any
from datetime import datetime
from dataclasses import dataclass, asdict, field


@dataclass
class EventMetadata:
    """
    Metadata that accompanies every event.
    
    - event_id: Unique identifier for this event
    - event_type: Type of event (e.g., "MarketDataReceived")
    - timestamp: When the event occurred (ISO 8601)
    - source: Where the event originated (e.g., "exchange_binance", "feature_engine")
    - correlation_id: Groups related events (e.g., all events from a single market data batch)
    - causation_id: Points to the event that caused this one
    - aggregate_id: Entity this event relates to (e.g., "BTCUSDT", "position_123")
    - schema_version: Version of the event schema
    """
    event_id: str = field(default_factory=lambda: f"evt_{uuid.uuid4().hex[:12]}")
    event_type: str = ""
    timestamp: str = field(default_factory=lambda: datetime.utcnow().isoformat() + "Z")
    source: str = ""
    correlation_id: str = field(default_factory=lambda: f"corr_{uuid.uuid4().hex[:12]}")
    causation_id: Optional[str] = None
    aggregate_id: str = ""
    schema_version: str = "1.0"
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary, excluding None values."""
        return {k: v for k, v in asdict(self).items() if v is not None}


@dataclass
class BaseEvent:
    """
    Base class for all events in the system.
    
    Contains metadata and payload, plus hash chain fields.
    
    Hash Chain Mechanism:
    - previous_hash: SHA256 of the previous event in the chain
    - event_hash: SHA256 computed as:
        SHA256(event_id + event_type + timestamp + correlation_id + 
               causation_id + payload_json + previous_hash)
    
    This ensures:
    1. Chain integrity (breaking any event breaks the chain)
    2. Causality integrity (causation_id is immutable)
    3. Payload integrity (payload is part of the hash)
    4. Sequence integrity (previous_hash creates ordering)
    """
    
    metadata: EventMetadata
    payload: Dict[str, Any] = field(default_factory=dict)
    previous_hash: Optional[str] = None
    event_hash: Optional[str] = None
    
    def compute_hash(self) -> str:
        """
        Compute SHA256 hash of this event.
        
        Hash includes:
        - metadata (event_id, event_type, timestamp, etc.)
        - payload (the actual business data)
        - previous_hash (the link in the chain)
        """
        # Build canonical representation
        canonical = {
            "event_id": self.metadata.event_id,
            "event_type": self.metadata.event_type,
            "timestamp": self.metadata.timestamp,
            "source": self.metadata.source,
            "correlation_id": self.metadata.correlation_id,
            "causation_id": self.metadata.causation_id,
            "aggregate_id": self.metadata.aggregate_id,
            "schema_version": self.metadata.schema_version,
            "payload": self.payload,
            "previous_hash": self.previous_hash or "",
        }
        
        # JSON with sorted keys for deterministic output
        json_str = json.dumps(canonical, sort_keys=True, separators=(",", ":"))
        
        # SHA256 hash
        return hashlib.sha256(json_str.encode()).hexdigest()
    
    def finalize(self) -> None:
        """
        Finalize the event by computing its hash.
        Should be called before storing in EventStore.
        """
        self.event_hash = self.compute_hash()
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert event to dictionary for serialization."""
        return {
            "metadata": self.metadata.to_dict(),
            "payload": self.payload,
            "previous_hash": self.previous_hash,
            "event_hash": self.event_hash,
        }
    
    def to_json(self) -> str:
        """Convert event to JSON."""
        return json.dumps(self.to_dict(), indent=2)
    
    @staticmethod
    def validate_hash(event_dict: Dict[str, Any]) -> bool:
        """
        Validate that an event's hash is correct.
        
        Recomputes hash from metadata + payload + previous_hash,
        and compares with stored event_hash.
        """
        metadata_dict = event_dict.get("metadata", {})
        payload = event_dict.get("payload", {})
        previous_hash = event_dict.get("previous_hash")
        stored_hash = event_dict.get("event_hash")
        
        canonical = {
            "event_id": metadata_dict.get("event_id"),
            "event_type": metadata_dict.get("event_type"),
            "timestamp": metadata_dict.get("timestamp"),
            "source": metadata_dict.get("source"),
            "correlation_id": metadata_dict.get("correlation_id"),
            "causation_id": metadata_dict.get("causation_id"),
            "aggregate_id": metadata_dict.get("aggregate_id"),
            "schema_version": metadata_dict.get("schema_version"),
            "payload": payload,
            "previous_hash": previous_hash or "",
        }
        
        json_str = json.dumps(canonical, sort_keys=True, separators=(",", ":"))
        computed_hash = hashlib.sha256(json_str.encode()).hexdigest()
        
        return computed_hash == stored_hash


# Factory function for creating typed events
def create_event(
    event_type: str,
    payload: Dict[str, Any],
    source: str,
    aggregate_id: str,
    correlation_id: Optional[str] = None,
    causation_id: Optional[str] = None,
    previous_hash: Optional[str] = None,
) -> BaseEvent:
    """
    Factory function to create and finalize an event.
    
    Args:
        event_type: Type of event (e.g., "MarketDataReceived")
        payload: Business data for this event
        source: Origin of the event
        aggregate_id: What entity this event relates to
        correlation_id: Groups related events (auto-generated if None)
        causation_id: Event that caused this one (optional)
        previous_hash: Hash of previous event (for chain linkage)
    
    Returns:
        Finalized BaseEvent ready for storage
    """
    metadata = EventMetadata(
        event_type=event_type,
        source=source,
        aggregate_id=aggregate_id,
        correlation_id=correlation_id or f"corr_{uuid.uuid4().hex[:12]}",
        causation_id=causation_id,
    )
    
    event = BaseEvent(
        metadata=metadata,
        payload=payload,
        previous_hash=previous_hash,
    )
    
    event.finalize()
    return event
