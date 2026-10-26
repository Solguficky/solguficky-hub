"""Байты фактов, закодированные эталонной реализацией (python protobuf) из
неизменённых contracts/proto: декодер спайка должен прочитать их тем же фактом."""
import pathlib, sys
sys.path.insert(0, "pygen")
from auction.v1 import auction_events_pb2 as ev

out = pathlib.Path("fixtures")
lot = ev.LotEvent(event_id="0192e5a0-0000-7000-8000-000000000001",
                  lot_id="0192e5a0-0000-7000-8000-0000000000aa", version=7,
                  occurred_at="2026-10-26T12:00:00Z")
lot.state.id = lot.lot_id
lot.state.trading.leader_id = "0192e5a0-0000-7000-8000-0000000000b1"
lot.bid_placed.manual.SetInParent()
(out / "lot_bid_placed.bin").write_bytes(lot.SerializeToString())

sold = ev.LotEvent(); sold.CopyFrom(lot); sold.lot_sold.SetInParent(); sold.version = 9
(out / "lot_sold.bin").write_bytes(sold.SerializeToString())

inv = ev.InvoiceEvent(event_id="0192e5a0-0000-7000-8000-000000000002",
                      invoice_id="5d0b8f3e-0000-5000-8000-000000000001", version=2,
                      occurred_at="2026-10-26T13:00:00Z")
inv.state.id = inv.invoice_id
inv.state.auction_id = "0192e5a0-0000-7000-8000-0000000000cc"
inv.state.lot_id = lot.lot_id
inv.state.winner_id = "0192e5a0-0000-7000-8000-0000000000b1"
inv.state.paid.SetInParent()
inv.invoice_paid.SetInParent()
(out / "invoice_paid.bin").write_bytes(inv.SerializeToString())

# Новый повод модуля: поле oneof с номером 99, которого читатель не знает.
# Тег 99<<3|2 = 794 -> varint 0x9a 0x06, длина 0 (пустое сообщение).
unknown = ev.LotEvent(); unknown.CopyFrom(lot); unknown.ClearField("occasion")
(out / "lot_unknown_occasion.bin").write_bytes(unknown.SerializeToString() + bytes([0x9a, 0x06, 0x00]))
print({p.name: p.stat().st_size for p in out.iterdir()})
