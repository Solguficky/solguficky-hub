package auction.grpc

/**
 * Допуск вызывающих по методу (ADR-056): данные, а не условие в обработчике.
 *
 * Строки повторяют колонку Caller каталога `docs/architecture/integration.md`, раздел «Auction gRPC». Метода, которого
 * в карте нет, не принимает никто — в том числе метода, который появится в контракте раньше своей строки здесь.
 */
object MethodAccess {

  val Service: String = "auction.v1.AuctionService"

  private val bots: Set[Caller] = Set(Caller.HubBot, Caller.AuctionBot)

  val byMethod: Map[String, Set[Caller]] = Map(
    "PlaceBid" -> bots,
    "SetProxyLimit" -> bots,
    "WithdrawProxyLimit" -> bots,
    "CreateLotCard" -> bots,
    "EditLotCard" -> bots,
    "GetLot" -> bots,
    "ListAuctionLots" -> bots,
    "ListLotHistory" -> bots,
    "ChooseDisplayName" -> bots,
    "GetDisplayNames" -> bots,
    "ListAuctionNames" -> Set(Caller.HubBot),
    "GetFaqAcknowledgement" -> Set(Caller.AuctionBot),
    "AcknowledgeFaq" -> Set(Caller.AuctionBot),
    "GetLotImage" -> bots,
    "AddLotPhoto" -> Set(Caller.HubBot),
    "RemoveLotPhoto" -> Set(Caller.HubBot),
    "GetLotPhoto" -> bots,
    "DraftAuction" -> Set(Caller.HubBot),
    "AddLot" -> bots,
    "RemoveLot" -> bots,
    "SaveLotSet" -> Set(Caller.HubBot),
    "DeleteLotSet" -> Set(Caller.HubBot),
    "ScheduleLot" -> Set(Caller.HubBot),
    "ScheduleAuction" -> Set(Caller.HubBot),
    "StartPrebidding" -> Set(Caller.HubBot),
    "DiscardAuction" -> Set(Caller.HubBot),
    "PublishAuction" -> Set(Caller.HubBot),
    "HideAuction" -> Set(Caller.HubBot),
    "CancelAuction" -> Set(Caller.HubBot),
    "SetFinalTime" -> Set(Caller.HubBot),
    "SelectForFinal" -> Set(Caller.HubBot),
    "DeselectForFinal" -> Set(Caller.HubBot),
    "PreviewParticipantRemoval" -> Set(Caller.HubBot),
    "RemoveParticipant" -> Set(Caller.HubBot),
    "LaunchStepWindow" -> Set(Caller.HubBot),
    "FreezeFinalLineup" -> Set(Caller.HubBot),
    "StartFinal" -> Set(Caller.HubBot),
    "StartNextLot" -> Set(Caller.HubBot),
    "AdvanceAsk" -> Set(Caller.HubBot),
    "CloseLot" -> Set(Caller.HubBot),
    "WatchAuction" -> bots,
    "GetAuctionConsole" -> Set(Caller.HubBot),
    "GetAuctionLotStatistics" -> Set(Caller.HubBot),
    "GetAuctionDaySummary" -> Set(Caller.HubBot),
    "GetMeetupAuction" -> Set(Caller.HubBot),
    "GetAuction" -> bots,
    "ListAuctions" -> bots,
    "RegisterForRaffle" -> bots,
    "CancelRaffleRegistration" -> bots,
    "GetRaffle" -> bots,
    "AssignRaffleWinner" -> Set(Caller.HubBot),
    "SubmitPrediction" -> bots,
    "GetMyPredictions" -> bots,
    "GetPredictionResults" -> bots,
    "SettlePredictionResultsManually" -> Set(Caller.HubBot),
    "MarkInvoicePaid" -> Set(Caller.HubBot),
    "MarkInvoiceHandedOver" -> Set(Caller.HubBot),
    "ChooseFulfillment" -> bots,
    "ListMyInvoices" -> bots,
    "ListAuctionInvoices" -> Set(Caller.HubBot),
    "SetPaymentInstructions" -> Set(Caller.HubBot)
  )

  /** Все вызывающие, которых объявил хотя бы один метод: таблица токенов обязана знать каждого. */
  val declared: Set[Caller] = byMethod.values.flatten.toSet

  /** Имя метода из пути gRPC-запроса `/<service>/<method>`; путь вне сервиса метода не называет. */
  def methodOf(path: String): Option[String] =
    path.stripPrefix("/").split('/') match {
      case Array(Service, method) if method.nonEmpty => Some(method)
      case _ => None
    }
}

/** Почему вызов не допущен. Все три отвечают `UNAUTHENTICATED`; различает их только запись границы. */
enum CallerRefusal(val field: String) {
  case MissingToken extends CallerRefusal("missing_token")
  case UnknownToken extends CallerRefusal("unknown_token")
  case NotDeclared extends CallerRefusal("not_declared")
}

/** Исход проверки вызывающего. У `NotDeclared` вызывающий опознан, и запись границы называет его. */
enum GateDecision {
  case Admitted(caller: Caller)
  case Refused(refusal: CallerRefusal, caller: Option[Caller])
}

/** Решение о вызывающем до обращения к сервису: кто пришёл и объявлен ли он у метода. */
object CallerGate {

  private val BearerPrefix = "bearer "

  /**
   * @param method
   *   имя метода из пути; `None` — путь вне сервиса
   * @param authorization
   *   значение заголовка `authorization`, если он пришёл
   */
  def decide(table: CallerTable, method: Option[String], authorization: Option[String]): GateDecision =
    authorization.filter(_.regionMatches(true, 0, BearerPrefix, 0, BearerPrefix.length)) match {
      case None => GateDecision.Refused(CallerRefusal.MissingToken, None)
      case Some(header) =>
        table.identify(header.substring(BearerPrefix.length).trim) match {
          case None => GateDecision.Refused(CallerRefusal.UnknownToken, None)
          case Some(caller) =>
            if (method.flatMap(MethodAccess.byMethod.get).exists(_.contains(caller))) GateDecision.Admitted(caller)
            else GateDecision.Refused(CallerRefusal.NotDeclared, Some(caller))
        }
    }
}
