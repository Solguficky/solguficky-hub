// Поверхность процесса (ADR-064, п. 18): чей это бот — хаба или аукциона.
export type Surface = "hub" | "auction";

export type SurfaceResult =
  | { ok: true; surface: Surface }
  | { ok: false; error: string };

export function readSurface(raw: string | undefined): SurfaceResult {
  if (raw === "hub" || raw === "auction") return { ok: true, surface: raw };
  return { ok: false, error: "BOT_SURFACE must be hub or auction" };
}
