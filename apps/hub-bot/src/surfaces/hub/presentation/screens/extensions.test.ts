import { describe, expect, it } from "vitest";
import type { MeetupSnapshot } from "../../meetups/port.js";
import { extensionsScreen } from "./extensions.js";

const meetup = {
  id: "0195f3a0-0000-7000-8000-000000000001",
  title: "Ярмарка",
  lifecycle: "published",
} as unknown as MeetupSnapshot;
const auctionId = "daef05c7-cd68-5048-b03d-cb4860e8dc73";
const hall = {
  screenUrl: "https://hall.example.org/screen",
  streamUrl: "https://stream.example.org/live",
};

type Auction = Parameters<typeof extensionsScreen>[0]["auction"];

const urls = (auction: Auction, links?: typeof hall) =>
  extensionsScreen({
    meetup,
    auction,
    manageable: false,
    ...(links === undefined ? {} : { hall: links }),
  }).keyboard.inline_keyboard.flatMap((row) =>
    row.flatMap((button) => ("url" in button ? [button.url] : [])),
  );

const atStage = (stage: string) =>
  ({
    kind: "open",
    auctionId,
    auction: { auctionId, stage },
  }) as unknown as Auction;

// Экран зала и стрим в «Расширениях» сходки (PER-825).
describe("extensions menu hall links", () => {
  const open: Auction = { kind: "open", auctionId };

  it("has no links without the settings", () => {
    expect(urls(open)).toEqual([]);
  });

  it("shows the screen and the stream of an open auction", () => {
    expect(urls(open, hall)).toEqual([
      `https://hall.example.org/screen/${auctionId}`,
      "https://stream.example.org/live",
    ]);
  });

  it("keeps the links while the auction runs and drops them after it ends", () => {
    expect(urls(atStage("prebidding"), hall)).toHaveLength(2);
    expect(urls(atStage("in-final"), hall)).toHaveLength(2);
    expect(urls(atStage("finished"), hall)).toEqual([]);
    expect(urls(atStage("cancelled"), hall)).toEqual([]);
  });

  it("has no links without an auction", () => {
    expect(urls({ kind: "none" }, hall)).toEqual([]);
    expect(urls({ kind: "unavailable" }, hall)).toEqual([]);
  });
});
