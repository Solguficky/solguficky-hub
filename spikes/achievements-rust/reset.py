"""Удаляет стрим ACH_FACTS на 127.0.0.1:4223 — чистый старт сценария."""
import asyncio, nats
async def main():
    nc = await nats.connect("nats://127.0.0.1:4223"); js = nc.jetstream()
    try: await js.delete_stream("ACH_FACTS")
    except Exception as e: print("no stream:", e)
    await nc.close()
asyncio.run(main())
