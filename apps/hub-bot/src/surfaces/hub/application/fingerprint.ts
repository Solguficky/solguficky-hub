// Пять знаков base36 от строки (FNV-1a): отпечаток для кнопки пульта и формы
// лота — окна, сета и версии фото у «Да, убрать фото» (PER-715). Кнопка несёт
// отпечаток вместо значения, которое в 64 байта не помещается, и сверяет его с
// прочитанным перед командой.
export function fingerprint(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % 36 ** 5).toString(36).padStart(5, "0");
}
