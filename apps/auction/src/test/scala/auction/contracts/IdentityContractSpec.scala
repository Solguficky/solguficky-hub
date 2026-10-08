package auction.contracts

import identity.v1.roles.AccessRight
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

/**
 * Кодогенерация — часть сборки, и этот тест держит её проверяемой.
 *
 * Без него расхождение сгенерированного кода со схемой обнаружилось бы только там, где типы впервые понадобятся домену,
 * то есть после доменного дизайна. Проверяется сама генерация из `contracts/proto`, а не поведение Identity: права
 * аукцион принимает от Identity (ADR-064) и своего списка людей не заводит.
 */
final class IdentityContractSpec extends AnyWordSpec with Matchers {

  "generated identity contract" should {

    "expose the rights the auction decides by" in {
      AccessRight.ACCESS_RIGHT_AUCTION.value shouldBe 2
      AccessRight.ACCESS_RIGHT_MANAGE_AUCTION.value shouldBe 5
    }

    // Значение 0 объявлено в схеме, и проверка на нём тавтологична. Открытость
    // enum видна только на числе, которого потребитель не знает: ScalaPB
    // возвращает Unrecognized, а не падает и не подставляет UNSPECIFIED —
    // см. docs/learning/protobuf/enum-openness.md.
    "keep a right it does not know instead of failing or flattening it" in {
      AccessRight.fromValue(99) shouldBe AccessRight.Unrecognized(99)
      AccessRight.fromValue(99).isUnrecognized shouldBe true
    }
  }
}
