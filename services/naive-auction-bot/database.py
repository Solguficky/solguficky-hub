import aiosqlite
import logging
from datetime import datetime
from typing import Optional, List, Dict

logger = logging.getLogger(__name__)

DB_PATH = "auction.db"

async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS bids (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                lot_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                amount REAL NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        await db.commit()
        logger.info("Database initialized successfully")

async def save_bid(lot_id: int, user_id: int, amount: float) -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            "INSERT INTO bids (lot_id, user_id, amount) VALUES (?, ?, ?)",
            (lot_id, user_id, amount)
        )
        await db.commit()
        bid_id = cursor.lastrowid
        logger.info(f"Saved bid {bid_id}: lot={lot_id}, user={user_id}, amount={amount}")
        return bid_id

async def get_lot_bids(lot_id: int) -> List[Dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM bids WHERE lot_id = ? ORDER BY created_at ASC",
            (lot_id,)
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]

async def get_current_max_bid(lot_id: int) -> Optional[Dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM bids WHERE lot_id = ? ORDER BY amount DESC LIMIT 1",
            (lot_id,)
        )
        row = await cursor.fetchone()
        return dict(row) if row else None

async def get_all_bids() -> List[Dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM bids ORDER BY created_at ASC")
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]

async def get_user_bids(user_id: int) -> List[Dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM bids WHERE user_id = ? ORDER BY created_at DESC",
            (user_id,)
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]

