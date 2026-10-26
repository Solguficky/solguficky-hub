// Сборка этого файла должна упасть с E0004: в match нет варианта LotSold.
use achievements_spike::facts::pb::lot_event::Occasion;
pub fn describe(o: &Occasion) -> &'static str {
    match o {
        Occasion::LotDrafted(_) => "drafted", Occasion::LotScheduled(_) => "scheduled",
        Occasion::LotOpened(_) => "opened", Occasion::BidPlaced(_) => "bid",
        Occasion::AskAdvanced(_) => "ask", Occasion::DeadlineExtended(_) => "ext",
        Occasion::LotUnsold(_) => "unsold", Occasion::LotWithdrawn(_) => "withdrawn",
        Occasion::LotHeldForFinal(_) => "held", Occasion::LotResumed(_) => "resumed",
        Occasion::StepWindowAdded(_) => "window", Occasion::ParticipantRemoved(_) => "removed",
        // Occasion::LotSold(_) => "sold",
    }
}
fn main() {}
