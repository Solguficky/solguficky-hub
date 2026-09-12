import { describe, expect, it } from "vitest";
import {
  meetupDeepLinkPayload,
  meetupStartLink,
  tokenToUuid,
  uuidToToken,
} from "./meetup-deep-link.js";
import { MeetupDeepLinkPayloadSchema } from "./schemas.js";

const meetupId = "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60";
const token = "AZLzpLXGfY6fChssPU5fYA";

describe("meetup deep link", () => {
  it("encodes a meetup id the same way the incoming start parser reads it", () => {
    expect(uuidToToken(meetupId)).toBe(token);
    expect(meetupDeepLinkPayload(meetupId)).toBe(`m_${token}`);
    expect(
      MeetupDeepLinkPayloadSchema.parse(meetupDeepLinkPayload(meetupId)),
    ).toBe(`m_${token}`);
    expect(tokenToUuid(meetupDeepLinkPayload(meetupId).slice(2))).toBe(meetupId);
  });

  it("builds a start link from the resolved bot username", () => {
    expect(meetupStartLink("stub_bot", meetupId)).toBe(
      `https://t.me/stub_bot?start=m_${token}`,
    );
  });
});
