//! Ачивки — единицы кода: определение и правило над фактами модуля.
use crate::facts::Fact;
use crate::store::Tx;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rule {
    Collector,
    FirstBidder,
    Bidder,
    FirstPayment,
}

#[derive(Debug, Clone, Copy)]
pub struct Achievement {
    pub code: &'static str,
    pub title: &'static str,
    pub single: bool,
    pub rule: Rule,
}

pub const COLLECTOR: Achievement = Achievement { code: "collector", title: "Коллекционер", single: false, rule: Rule::Collector };
pub const FIRST_BIDDER: Achievement = Achievement { code: "first_bidder", title: "Первый ставочник", single: true, rule: Rule::FirstBidder };
pub const BIDDER: Achievement = Achievement { code: "bidder", title: "Ставочник", single: false, rule: Rule::Bidder };
pub const FIRST_PAYMENT: Achievement = Achievement { code: "first_payment", title: "Первая покупка", single: false, rule: Rule::FirstPayment };

impl Achievement {
    pub fn by_code(code: &str) -> Option<Achievement> {
        [COLLECTOR, FIRST_BIDDER, BIDDER, FIRST_PAYMENT].into_iter().find(|a| a.code == code)
    }

    /// Исполняется внутри транзакции факта; отдаёт субъектов-кандидатов к выдаче.
    /// Уникальность выдачи держит схема, правило о ней не думает.
    pub async fn apply(&self, tx: &mut Tx<'_>, fact: &Fact) -> sqlx::Result<Vec<String>> {
        Ok(match self.rule {
            // «Коллекционер»: оплатил три лота. Состояние — число оплат субъекта.
            Rule::Collector => match fact.payer() {
                Some(w) => {
                    let n = tx.bump_count(self.code, w).await?;
                    if n == 3 { vec![w.to_owned()] } else { vec![] }
                }
                None => vec![],
            },
            // «Первый ставочник»: первая ставка в стриме; второй выдачи не даст UNIQUE(achievement).
            Rule::FirstBidder | Rule::Bidder => fact.bidder().map(|b| vec![b.to_owned()]).unwrap_or_default(),
            // «Первая покупка»: оплатил лот. Добавляется позже и дочитывает стрим.
            Rule::FirstPayment => fact.payer().map(|w| vec![w.to_owned()]).unwrap_or_default(),
        })
    }
}
