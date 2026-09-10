"""
Configuration module for QSX-AOS.

Centraliza todas as configurações com fail-safe para live trading.
"""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application configuration."""
    
    # Application
    app_name: str = "QSX-AOS ONE"
    environment: str = "development"  # development, staging, production
    debug: bool = True
    
    # Execution Mode
    execution_mode: str = "PAPER"  # PAPER, SHADOW, MICRO-REAL, LIVE-SAFE, LIVE
    live_trading_enabled: bool = False  # FAIL-SAFE: must be explicitly True
    
    # Database
    database_url: str = "postgresql+psycopg://qsx:qsx@localhost:5432/qsx"
    
    # Redis
    redis_url: str = "redis://localhost:6379/0"
    
    # Risk Management
    max_position_risk: float = 0.01  # 1% per position
    max_daily_loss: float = 0.03  # 3% daily loss limit
    max_drawdown: float = 0.10  # 10% maximum drawdown
    max_position_size: float = 0.05  # 5% max exposure per position
    
    # Portfolio
    initial_capital: float = 100000.0
    base_currency: str = "USDT"
    
    # Features
    lookback_periods: int = 100
    feature_lookback: int = 50
    
    # Health Check
    health_check_interval: int = 60  # seconds
    event_store_sync_interval: int = 5
    
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )
    
    def validate_live_trading(self) -> bool:
        """
        Fail-safe validation before any live trade.
        
        Returns:
            True if live trading is explicitly enabled and environment is correct
        """
        if self.execution_mode in ["LIVE", "LIVE-SAFE"]:
            if not self.live_trading_enabled:
                raise RuntimeError(
                    "CRITICAL: Live trading disabled. "
                    "Set live_trading_enabled=True to proceed."
                )
            if self.environment != "production":
                raise RuntimeError(
                    "CRITICAL: Live trading only allowed in production environment."
                )
            return True
        return False


# Global settings instance
settings = Settings()

# Ensure fail-safe on startup
if settings.execution_mode in ["LIVE", "LIVE-SAFE"]:
    settings.validate_live_trading()
