package auction.contracts

import identity.v1.roles.GlobalRole
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

/**
 * Кодогенерация — часть сборки, и этот тест держит её проверяемой.
 *
 * Без него расхождение сгенерированного кода со схемой обнаружилось бы только там, где типы впервые понадобятся домену,
 * то есть после доменного дизайна. Проверяется сама генерация из `contracts/proto`, а не поведение Identity: роли
 * аукцион принимает по ADR-043 и своего списка людей не заводит.
 */
final class IdentityContractSpec extends AnyWordSpec with Matchers {

  "generated identity contract" should {

    "expose the outer circle role the auction link grants" in {
      GlobalRole.GLOBAL_ROLE_PUBLIC.value shouldBe 4
    }

    // Значение 0 объявлено в схеме, и проверка на нём тавтологична. Открытость
    // enum видна только на числе, которого потребитель не знает: ScalaPB
    // возвращает Unrecognized, а не падает и не подставляет UNSPECIFIED —
    // см. docs/learning/protobuf/enum-openness.md.
    "keep a role it does not know instead of failing or flattening it" in {
      GlobalRole.fromValue(99) shouldBe GlobalRole.Unrecognized(99)
      GlobalRole.fromValue(99).isUnrecognized shouldBe true
    }
  }
}
