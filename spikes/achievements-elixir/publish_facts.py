"""Публикует синтетические факты аукциона в стрим ACH_FACTS (events.auction.>).

Байты кодирует python protobuf из неизменённых contracts/proto. Два факта
публикуются повторно под другим Nats-Msg-Id — так выглядит повтор релея outbox
после окна дедупликации JetStream: отсечь его должна строка processed.
usage: publish_facts.py <phase>   phase 1 — 40 фактов, phase 3 — ещё 6.
"""
import asyncio, sys, uuid
sys.path.insert(0, "pygen")
from auction.v1 import auction_events_pb2 as ev
import nats

AUCTION = "0192e5a0-0000-7000-8000-0000000000cc"
def uid(n): return f"0192e5a0-0000-7000-8000-{n:012d}"

def bid(n, lot, bidder):
    e = ev.LotEvent(event_id=uid(1000 + n), lot_id=uid(lot), version=n, occurred_at="2026-10-26T12:00:00Z")
    e.state.id = e.lot_id; e.state.auction_id = AUCTION
    e.state.trading.leader_id = bidder
    e.bid_placed.manual.SetInParent()
    return "events.auction.bid_placed", e.event_id, e.SerializeToString()

def paid(n, lot, winner):
    e = ev.InvoiceEvent(event_id=uid(2000 + n), invoice_id=str(uuid.uuid5(uuid.NAMESPACE_URL, f"inv{n}")),
                        version=2, occurred_at="2026-10-26T13:00:00Z")
    e.state.id = e.invoice_id; e.state.auction_id = AUCTION; e.state.lot_id = uid(lot); e.state.winner_id = winner
    e.state.paid.SetInParent(); e.invoice_paid.SetInParent()
    return "events.auction.invoice_paid", e.event_id, e.SerializeToString()

B = [uid(500 + i) for i in range(6)]   # участники B0..B5

def phase1():
    facts = []
    for i in range(24):                 # ставки: первый ставочник — B2
        facts.append(bid(i, 100 + i % 8, B[(i + 2) % 5]))
    payers = [B[0], B[1], B[0], B[3], B[1], B[0], B[3], B[4], B[3], B[1], B[4], B[2], B[0], B[2], B[4], B[1]]
    for i, w in enumerate(payers):      # B0:4, B1:4, B3:3, B4:3, B2:2 оплаты
        facts.append(paid(i, 200 + i, w))
    return facts

def phase3():
    return [bid(100, 300, B[5]), paid(100, 301, B[5]), paid(101, 302, B[5]),
            paid(102, 303, B[5]), bid(101, 304, B[2]), paid(103, 305, B[2])]

async def main():
    nc = await nats.connect("nats://127.0.0.1:4222")
    js = nc.jetstream()
    await js.add_stream(name="ACH_FACTS", subjects=["events.auction.>"], duplicate_window=120)
    facts = phase1() if sys.argv[1] == "1" else phase3()
    for subj, eid, data in facts:
        await js.publish(subj, data, headers={"Nats-Msg-Id": eid})
    if sys.argv[1] == "1":
        for subj, eid, data in (facts[3], facts[30]):   # повтор релея после окна
            await js.publish(subj, data, headers={"Nats-Msg-Id": eid + "-relay-retry"})
    info = await js.stream_info("ACH_FACTS")
    print("published", len(facts), "last_seq", info.state.last_seq)
    await nc.close()

asyncio.run(main())
