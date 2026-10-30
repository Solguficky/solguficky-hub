import { describe, expect, it } from "vitest";
import {
  type Clock,
  createEditLimiter,
  type EditOutcome,
} from "./edit-limiter.js";

// Управляемые часы: время двигает тест, отложенные вызовы срабатывают по
// порядку своего момента. Глобальные фейковые таймеры здесь не нужны — часы
// лимитер получает портом.
function manualClock() {
  let now = 0;
  const timers: { at: number; run: () => void; live: boolean }[] = [];
  const clock: Clock = {
    now: () => now,
    later(run, ms) {
      const timer = { at: now + ms, run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
  };
  // Микрозадачи правок успевают завершиться между тиками.
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };
  return {
    clock,
    now: () => now,
    async advance(ms: number) {
      const until = now + ms;
      await settle();
      for (;;) {
        const due = timers
          .filter((t) => t.live && t.at <= until)
          .sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        due.live = false;
        now = Math.max(now, due.at);
        due.run();
        await settle();
      }
      now = until;
      await settle();
    },
  };
}

type Edit = { at: number; chatId: number; price: number };

function recorder(time: () => number) {
  const edits: Edit[] = [];
  const task =
    (chatId: number, price: number, outcome: EditOutcome = { kind: "done" }) =>
    async () => {
      edits.push({ at: time(), chatId, price });
      return outcome;
    };
  return { edits, task };
}

describe("edit limiter", () => {
  it("keeps the last state of a message and drops the ones in between", async () => {
    const time = manualClock();
    const limiter = createEditLimiter({ clock: time.clock });
    const { edits, task } = recorder(time.now);
    for (const price of [1000, 1100, 1200, 1300]) {
      limiter.submit(1, "1:10", task(1, price));
    }
    await time.advance(5_000);
    // Первая уходит сразу, следующие три ждут свою секунду, и из них
    // доходит последняя.
    expect(edits.map((e) => e.price)).toEqual([1000, 1300]);
  });

  it("edits one chat not more often than once a second", async () => {
    const time = manualClock();
    const limiter = createEditLimiter({ clock: time.clock });
    const { edits, task } = recorder(time.now);
    for (let second = 0; second < 5; second += 1) {
      for (let i = 0; i < 10; i += 1) {
        limiter.submit(1, "1:10", task(1, second * 100 + i));
      }
      await time.advance(250);
    }
    await time.advance(5_000);
    const gaps = edits.slice(1).map((e, i) => e.at - (edits[i]?.at ?? 0));
    expect(gaps.every((gap) => gap >= 1_000)).toBe(true);
    expect(edits.at(-1)?.price).toBe(409);
  });

  // Критерий PER-336: 50 открытых карточек на залпе ставок не упираются в
  // лимит Telegram, и у каждой доходит последняя цена.
  it("spreads a volley over 50 cards within the bot limit and delivers every last price", async () => {
    const time = manualClock();
    const limiter = createEditLimiter({ clock: time.clock });
    const { edits, task } = recorder(time.now);
    // 200 состояний за секунду: каждое правит все 50 карточек.
    for (let state = 1; state <= 200; state += 1) {
      for (let chat = 1; chat <= 50; chat += 1) {
        limiter.submit(chat, `${chat}:1`, task(chat, state));
      }
      await time.advance(5);
    }
    await time.advance(10_000);
    // Не больше 25 правок в любом окне в секунду.
    for (const edit of edits) {
      const inWindow = edits.filter(
        (e) => e.at > edit.at - 1_000 && e.at <= edit.at,
      );
      expect(inWindow.length).toBeLessThanOrEqual(25);
    }
    // У каждой карточки последней дошла последняя цена залпа.
    for (let chat = 1; chat <= 50; chat += 1) {
      const own = edits.filter((e) => e.chatId === chat);
      expect(own.at(-1)?.price).toBe(200);
    }
    // Последняя цена у всех — не позже двух секунд после конца залпа.
    const lastAt = Math.max(
      ...edits.filter((e) => e.price === 200).map((e) => e.at),
    );
    expect(lastAt).toBeLessThanOrEqual(1_000 + 2_000);
  });

  it("pauses the whole bot on 429 without losing the edit", async () => {
    const time = manualClock();
    const limiter = createEditLimiter({ clock: time.clock });
    const { edits, task } = recorder(time.now);
    limiter.submit(
      1,
      "1:10",
      task(1, 1000, { kind: "retry-after", ms: 3_000 }),
    );
    await time.advance(10);
    limiter.submit(2, "2:10", task(2, 2000));
    await time.advance(2_000);
    // Пауза общая: второй чат тоже ждёт.
    expect(edits.map((e) => e.chatId)).toEqual([1]);
    await time.advance(2_000);
    // После паузы уходят и вторая правка, и та, что не прошла.
    expect(edits.map((e) => e.chatId).sort()).toEqual([1, 1, 2]);
  });

  it("forgets a dropped edit", async () => {
    const time = manualClock();
    const limiter = createEditLimiter({ clock: time.clock });
    const { edits, task } = recorder(time.now);
    limiter.submit(1, "1:10", task(1, 1000));
    limiter.submit(1, "1:10", task(1, 1100));
    limiter.drop("1:10");
    await time.advance(5_000);
    expect(edits.map((e) => e.price)).toEqual([1000]);
    expect(limiter.waiting()).toBe(0);
  });

  it("keeps working after an edit throws", async () => {
    const time = manualClock();
    const failures: unknown[] = [];
    const limiter = createEditLimiter({
      clock: time.clock,
      onError: (_key, cause) => failures.push(cause),
    });
    const { edits, task } = recorder(time.now);
    limiter.submit(1, "1:10", async () => {
      throw new Error("boom");
    });
    await time.advance(10);
    limiter.submit(2, "2:10", task(2, 1));
    await time.advance(10);
    expect(failures).toHaveLength(1);
    expect(edits.map((e) => e.chatId)).toEqual([2]);
  });

  // PER-826: трансляция хода торгов идёт фоновой полосой и не задерживает
  // карточки финала.
  describe("background lane", () => {
    it("never takes more than its slots of the window", async () => {
      const time = manualClock();
      const limiter = createEditLimiter({ clock: time.clock });
      const { edits, task } = recorder(time.now);
      for (let chat = 1; chat <= 40; chat += 1) {
        limiter.submit(chat, `bc:${chat}`, task(chat, 1), "background");
      }
      await time.advance(10_000);
      expect(edits).toHaveLength(40);
      for (const edit of edits) {
        const inWindow = edits.filter(
          (e) => e.at > edit.at - 1_000 && e.at <= edit.at,
        );
        expect(inWindow.length).toBeLessThanOrEqual(15);
      }
    });

    it("lets a final card edit start without waiting behind the broadcast", async () => {
      const time = manualClock();
      const limiter = createEditLimiter({ clock: time.clock });
      const { edits, task } = recorder(time.now);
      // 30 подписчиков заняли полосу: на старте секунды 15 правок, 15 ждут.
      for (let chat = 1; chat <= 30; chat += 1) {
        limiter.submit(chat, `bc:${chat}`, task(chat, 1), "background");
      }
      await time.advance(10);
      expect(edits).toHaveLength(15);
      // Карточка финала пришла позже всех, но стартует сразу, а не после
      // 15 ждущих правок трансляции.
      limiter.submit(100, "100:1", task(100, 7));
      await time.advance(10);
      expect(edits.some((e) => e.chatId === 100)).toBe(true);
      expect(edits.filter((e) => e.chatId < 100)).toHaveLength(15);
    });

    it("serves the foreground first when both wait", async () => {
      const time = manualClock();
      const limiter = createEditLimiter({
        clock: time.clock,
        perSecond: 2,
        backgroundSlots: 1,
      });
      const { edits, task } = recorder(time.now);
      limiter.submit(1, "bc:1", task(1, 1), "background");
      limiter.submit(2, "bc:2", task(2, 1), "background");
      limiter.submit(3, "3:1", task(3, 1));
      await time.advance(5_000);
      expect(edits.map((e) => e.chatId)).toEqual([1, 3, 2]);
    });

    it("pauses the whole bot on 429 and still delivers the last edit", async () => {
      const time = manualClock();
      const limiter = createEditLimiter({ clock: time.clock });
      const { edits, task } = recorder(time.now);
      limiter.submit(
        1,
        "bc:1",
        task(1, 1, { kind: "retry-after", ms: 3_000 }),
        "background",
      );
      await time.advance(10);
      limiter.submit(2, "2:1", task(2, 1));
      await time.advance(2_000);
      expect(edits.map((e) => e.chatId)).toEqual([1]);
      await time.advance(3_000);
      expect(edits.map((e) => e.chatId).sort()).toEqual([1, 1, 2]);
    });
  });
});
