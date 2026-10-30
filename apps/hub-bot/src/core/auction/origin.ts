import {
  encodeAuctionCallback,
  parseAuctionCallback,
} from "../../auction-ui/index.js";

// Возврат берётся из показанной клавиатуры, поэтому переживает рестарт
// процесса. Права снова проверит шлюз при нажатии.
export function auctionRootFrom(
  callbacks: readonly string[],
): string | undefined {
  for (const data of callbacks) {
    const parsed = parseAuctionCallback(data);
    if (parsed.ok && "auctionId" in parsed.intent) {
      return encodeAuctionCallback({
        kind: "root",
        auctionId: parsed.intent.auctionId,
      });
    }
  }
  return undefined;
}
