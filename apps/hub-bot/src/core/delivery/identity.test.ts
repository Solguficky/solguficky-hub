import { describe, expect, it } from "vitest";
import { classifyRecipientFailure, isPermanentFailure } from "./identity.js";

// Отказ в той форме, в какой его несёт ConnectError: числовой код gRPC в `code`.
function grpcError(code: number) {
  return Object.assign(new Error("rpc failed"), { code });
}

describe("classifyRecipientFailure", () => {
  it("tells an unknown profile from a blocked one", () => {
    expect(classifyRecipientFailure(grpcError(5))).toEqual({
      kind: "not-found",
    });
    expect(classifyRecipientFailure(grpcError(9))).toEqual({ kind: "blocked" });
  });

  it("names a permanent refusal by its gRPC code", () => {
    expect(classifyRecipientFailure(grpcError(16))).toMatchObject({
      kind: "rejected",
      code: "Unauthenticated",
    });
  });

  it("treats a transient code and a failure without a code as unavailable", () => {
    expect(classifyRecipientFailure(grpcError(14))).toMatchObject({
      kind: "unavailable",
    });
    expect(classifyRecipientFailure(new Error("reset"))).toMatchObject({
      kind: "unavailable",
    });
  });
});

describe("isPermanentFailure", () => {
  it("is true only for codes a retry cannot change", () => {
    expect(isPermanentFailure(grpcError(7))).toBe(true);
    expect(isPermanentFailure(grpcError(4))).toBe(false);
    expect(isPermanentFailure(new Error("reset"))).toBe(false);
  });
});
