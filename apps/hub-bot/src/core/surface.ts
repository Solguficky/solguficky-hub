// Поверхность процесса (ADR-064, п. 18): чей это бот — хаба, аукциона или
// поддержки (ADR-068, п. 1).
export type Surface = "hub" | "auction" | "support";

export type SurfaceResult =
  | { ok: true; surface: Surface }
  | { ok: false; error: string };

export function readSurface(raw: string | undefined): SurfaceResult {
  if (raw === "hub" || raw === "auction" || raw === "support") {
    return { ok: true, surface: raw };
  }
  return { ok: false, error: "BOT_SURFACE must be hub, auction or support" };
}
