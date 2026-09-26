import { describe, expect, it } from "vitest";
import { natsConnectOptions } from "./nats.js";

describe("natsConnectOptions", () => {
  it("moves credentials out of the Aspire connection string", () => {
    expect(natsConnectOptions("nats://nats:p%40ss@localhost:41222")).toEqual({
      servers: "localhost:41222",
      user: "nats",
      pass: "p@ss",
    });
  });

  it("connects anonymously to the default port without credentials", () => {
    expect(natsConnectOptions("nats://127.0.0.1")).toEqual({
      servers: "127.0.0.1:4222",
    });
  });
});
