//// Ручной слой Protobuf: читатель wire-формата без кодогенерации.
//// protozoa 2.0.3 не генерирует компилируемый код по контрактам аукциона,
//// поэтому здесь ровно то, что нужно правилам: поля конверта и номер occasion.

import gleam/bit_array
import gleam/list
import gleam/result

pub type Value {
  Varint(Int)
  Bytes(BitArray)
  Fixed64(BitArray)
  Fixed32(BitArray)
}

pub type Field {
  Field(number: Int, value: Value)
}

pub fn fields(bytes: BitArray) -> Result(List(Field), String) {
  do_fields(bytes, [])
}

fn do_fields(bytes: BitArray, acc: List(Field)) -> Result(List(Field), String) {
  case bytes {
    <<>> -> Ok(list.reverse(acc))
    _ -> {
      use #(key, rest) <- result.try(varint(bytes, 0, 0))
      let number = key / 8
      case key % 8, rest {
        0, _ -> {
          use #(v, rest) <- result.try(varint(rest, 0, 0))
          do_fields(rest, [Field(number, Varint(v)), ..acc])
        }
        1, <<v:bytes-size(8), rest:bytes>> ->
          do_fields(rest, [Field(number, Fixed64(v)), ..acc])
        2, _ -> {
          use #(len, rest) <- result.try(varint(rest, 0, 0))
          case rest {
            <<v:bytes-size(len), rest:bytes>> ->
              do_fields(rest, [Field(number, Bytes(v)), ..acc])
            _ -> Error("truncated length-delimited field")
          }
        }
        5, <<v:bytes-size(4), rest:bytes>> ->
          do_fields(rest, [Field(number, Fixed32(v)), ..acc])
        _, _ -> Error("bad wire type or truncated field")
      }
    }
  }
}

fn varint(bytes: BitArray, shift: Int, acc: Int) -> Result(#(Int, BitArray), String) {
  case bytes {
    <<1:1, b:7, rest:bytes>> -> varint(rest, shift + 7, acc + b * pow2(shift))
    <<0:1, b:7, rest:bytes>> -> Ok(#(acc + b * pow2(shift), rest))
    _ -> Error("truncated varint")
  }
}

fn pow2(n: Int) -> Int {
  case n {
    0 -> 1
    _ -> 2 * pow2(n - 1)
  }
}

/// Последнее значение поля побеждает, как в спецификации proto3.
pub fn last(fs: List(Field), number: Int) -> Result(Value, Nil) {
  list.fold(fs, Error(Nil), fn(found, f) {
    case f.number == number {
      True -> Ok(f.value)
      False -> found
    }
  })
}

pub fn string(fs: List(Field), number: Int) -> String {
  case last(fs, number) {
    Ok(Bytes(b)) -> result.unwrap(bit_array.to_string(b), "")
    _ -> ""
  }
}

pub fn int(fs: List(Field), number: Int) -> Int {
  case last(fs, number) {
    Ok(Varint(v)) -> v
    _ -> 0
  }
}

pub fn message(fs: List(Field), number: Int) -> List(Field) {
  case last(fs, number) {
    Ok(Bytes(b)) -> result.unwrap(fields(b), [])
    _ -> []
  }
}

/// Номер поля oneof, пришедший последним среди перечисленных, — правило proto3.
pub fn oneof(fs: List(Field), numbers: List(Int)) -> Result(Int, Nil) {
  list.fold(fs, Error(Nil), fn(found, f) {
    case list.contains(numbers, f.number) {
      True -> Ok(f.number)
      False -> found
    }
  })
}
