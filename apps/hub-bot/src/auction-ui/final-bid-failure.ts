// Только отказ начального чтения: PlaceBid ещё не вызывался. Сбой после
// отправки команды не доказывает, что ставки не было.
export class FinalBidReadUnavailable extends Error {
  constructor(cause: unknown) {
    super("Аукцион недоступен, ставка не принята", { cause });
    this.name = "FinalBidReadUnavailable";
  }
}
