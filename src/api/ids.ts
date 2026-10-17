/**
 * Short ids, jj style: every Durable record (conversation, entry, submission, task) has a store-wide integer id, written
 * here as letters `k`-`z` after a reversible bit mix, so neighbours don't look alike. Unique and stable by construction,
 * with no index or storage, and any client derives them from the ids it already has. 4 letters below 65,536 ids, then
 * 5, up to 8. Changing the mix changes every id: the tests pin it.
 */

const MIN_LENGTH = 4;
const MAX_LENGTH = 8;
const MULTIPLIER = 0x2c1b3c6d;

/** `MULTIPLIER`'s inverse modulo 2^32, by Newton's iteration; it is also the inverse modulo every smaller power of two. */
const INVERSE = (() => {
  let inverse = MULTIPLIER;
  for (let step = 0; step < 5; step++)
    inverse = Math.imul(inverse, 2 - Math.imul(MULTIPLIER, inverse));
  return inverse;
})();

/** Each step is invertible on `bits`-bit integers: a xorshift by half the width undoes itself. */
function mix(value: number, bits: number, multiplier: number): number {
  const half = bits / 2;
  const mask = 2 ** bits - 1;
  let x = (value ^ (value >>> half)) >>> 0;
  x = (Math.imul(x, multiplier) >>> 0) & mask;
  return (x ^ (x >>> half)) >>> 0;
}

/** The short id of a Durable record id. */
export function shortId(id: number): string {
  if (!Number.isSafeInteger(id) || id < 0 || id >= 16 ** MAX_LENGTH)
    throw new Error(`No short id for ${id}`);
  const length = Math.max(MIN_LENGTH, id.toString(16).length);
  const hex = mix(id, length * 4, MULTIPLIER)
    .toString(16)
    .padStart(length, "0");
  return hex.replace(/[0-9a-f]/g, (digit) => String.fromCharCode(122 - parseInt(digit, 16)));
}

/** The Durable record id a short id names, or `undefined` for text that is not one. */
export function parseShortId(code: string): number | undefined {
  if (!/^[k-z]+$/.test(code) || code.length < MIN_LENGTH || code.length > MAX_LENGTH)
    return undefined;
  const mixed = parseInt(
    code.replace(/[k-z]/g, (letter) => (122 - letter.charCodeAt(0)).toString(16)),
    16,
  );
  const id = mix(mixed, code.length * 4, INVERSE);
  // Each length holds only the ids too large for the one before it, so every id has exactly one short id.
  return code.length > MIN_LENGTH && id < 16 ** (code.length - 1) ? undefined : id;
}
