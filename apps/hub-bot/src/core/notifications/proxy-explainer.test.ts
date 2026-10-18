import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import {
  createProxyExplainerPort,
  type ProxyExplainerRpc,
} from "./proxy-explainer.js";

const viewer = { identityId: "id-1", rights: ["place-bids"] as const };
const callOptions = { timeoutMs: 1_000, headers: { "x-request-id": "req-1" } };

function rpcWith(overrides: Partial<Record<keyof ProxyExplainerRpc, unknown>>) {
  // Моки отвечают формой сгенерированных сообщений без их классов: это
  // единственное ослабление типа в тесте.
  return {
    getProxyExplainer: vi.fn(async () => ({ seen: true })),
    markProxyExplainerSeen: vi.fn(async () => ({ seen: true })),
    ...overrides,
  } as unknown as ProxyExplainerRpc & {
    getProxyExplainer: ReturnType<typeof vi.fn>;
    markProxyExplainerSeen: ReturnType<typeof vi.fn>;
  };
}

describe("proxy explainer port", () => {
  it("sends the viewer's own identity and the call options", async () => {
    const rpc = rpcWith({});
    const port = createProxyExplainerPort(rpc, () => callOptions);

    expect(await port.seen(viewer)).toBe(true);
    await port.markSeen(viewer);
    expect(rpc.getProxyExplainer).toHaveBeenCalledWith(
      { identityId: "id-1" },
      callOptions,
    );
    expect(rpc.markProxyExplainerSeen).toHaveBeenCalledWith(
      { identityId: "id-1" },
      callOptions,
    );
  });

  it("reads an unmarked person as not seen", async () => {
    const port = createProxyExplainerPort(
      rpcWith({ getProxyExplainer: vi.fn(async () => ({ seen: false })) }),
      () => callOptions,
    );

    expect(await port.seen(viewer)).toBe(false);
  });

  // Отказ гасит дерево; порт только сообщает о нём, чтобы деградация не была
  // молчаливой.
  it("reports a refusal before throwing it", async () => {
    const refused = new ConnectError("down", Code.Unavailable);
    const onRefused = vi.fn();
    const port = createProxyExplainerPort(
      rpcWith({
        getProxyExplainer: vi.fn(async () => {
          throw refused;
        }),
        markProxyExplainerSeen: vi.fn(async () => {
          throw refused;
        }),
      }),
      () => callOptions,
      onRefused,
    );

    await expect(port.seen(viewer)).rejects.toBe(refused);
    await expect(port.markSeen(viewer)).rejects.toBe(refused);
    expect(onRefused).toHaveBeenCalledTimes(2);
    expect(onRefused).toHaveBeenCalledWith(refused);
  });
});
