import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import {
  callHeaders,
  callTimeoutMs,
  requestIdHeader,
  rpcMeta,
  useCaseHeader,
} from "./rpc-metadata.js";

describe("rpc metadata", () => {
  it("omits headers when the edge produced neither value", () => {
    expect(callHeaders()).toEqual({});
    expect(callHeaders({})).toEqual({});
    expect(rpcMeta({})).toBeUndefined();
  });

  it("sends only the fields that the edge actually has", () => {
    expect(callHeaders({ requestId: "req-1" })).toEqual({
      headers: { [requestIdHeader]: "req-1" },
    });
    expect(callHeaders({ useCase: "view_meetup" })).toEqual({
      headers: { [useCaseHeader]: "view_meetup" },
    });
    expect(rpcMeta({ requestId: "", useCase: "start" })).toEqual({
      requestId: "",
      useCase: "start",
    });
  });

  it("does not send empty strings as headers", () => {
    expect(callHeaders({ requestId: "", useCase: "" })).toEqual({});
  });

  it("carries the action deadline without turning it into a header", () => {
    expect(rpcMeta({ deadlineAt: 5_000 })).toEqual({ deadlineAt: 5_000 });
    expect(callHeaders({ deadlineAt: 5_000 })).toEqual({});
  });
});

describe("callTimeoutMs", () => {
  it("keeps the call's own deadline when the action has no budget", () => {
    expect(callTimeoutMs(undefined, 3_000)).toBe(3_000);
    expect(callTimeoutMs({ requestId: "req-1" }, 3_000)).toBe(3_000);
  });

  it("takes the smaller of the own deadline and the budget left", () => {
    expect(callTimeoutMs({ deadlineAt: 10_000 }, 3_000, 4_000)).toBe(3_000);
    expect(callTimeoutMs({ deadlineAt: 10_000 }, 3_000, 8_500)).toBe(1_500);
  });

  it("refuses the call as a deadline once the budget is spent", () => {
    const spent = () => callTimeoutMs({ deadlineAt: 10_000 }, 3_000, 10_000);

    expect(spent).toThrow(ConnectError);
    expect(spent).toThrow(
      expect.objectContaining({ code: Code.DeadlineExceeded }),
    );
  });
});
