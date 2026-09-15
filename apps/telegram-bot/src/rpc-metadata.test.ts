import { describe, expect, it } from "vitest";
import {
  callHeaders,
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
});
