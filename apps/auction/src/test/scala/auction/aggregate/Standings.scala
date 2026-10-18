package auction.aggregate

/** Состояния сходки из ответа Meetups для тестов ворот (ADR-047, дополнение 2026-10-12). */
object Standings {
  val published: Option[MeetupStanding] = Some(MeetupStanding(MeetupLifecycle.Planned, MeetupVisibility.Visible))
  val hidden: Option[MeetupStanding] = Some(MeetupStanding(MeetupLifecycle.Planned, MeetupVisibility.Hidden))
  val cancelled: Option[MeetupStanding] = Some(MeetupStanding(MeetupLifecycle.Cancelled, MeetupVisibility.Visible))
}
