import type { Surface } from "./surface.js";

// Имя сервиса — у каждой поверхности своё (ADR-064, п. 18): по нему записи,
// метрики и трейсы двух процессов не смешиваются, а пакет доставки выводит из
// него durable, bucket журнала и счётчик (`hub-bot-…`, `auction-bot-…`).
export const serviceNames = {
  hub: "hub-bot",
  auction: "auction-bot",
} as const satisfies Record<Surface, string>;

export type ServiceName = (typeof serviceNames)[Surface];

// Имя — свойство процесса, а не вызова: его привязывает выбор поверхности в
// `src/main.ts` до первого сигнала. Счётчик сбоев и трейсер читают его отсюда,
// а не из параметров, потому что зовут их глубоко внутри поверхности. До
// привязки — имя хаба: так работают наборы хаба, которые процесс не запускают.
let bound: ServiceName = serviceNames.hub;

export function bindService(surface: Surface): ServiceName {
  bound = serviceNames[surface];
  return bound;
}

export function serviceName(): ServiceName {
  return bound;
}
