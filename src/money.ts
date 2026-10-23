/**
 * ISO 4217 minor-unit exponents that are not 2. The same table as the Whisperr
 * server (whisperr-go eventfacts and the Shopify connector).
 */
const MINOR_DIGITS: Record<string, number> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0,
  RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  CLF: 4, UYW: 4,
};

const CURRENCY = /^[A-Za-z]{3}$/;
const DECIMAL = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/** The number of minor-unit digits for an ISO 4217 code (2 unless listed). */
export function currencyExponent(currency: string): number {
  if (typeof currency !== "string" || !CURRENCY.test(currency)) {
    throw new RangeError(`[whisperr] invalid currency "${currency}" — expected an ISO 4217 code`);
  }
  return MINOR_DIGITS[currency.toUpperCase()] ?? 2;
}

/**
 * Converts a price in major units to an integer of minor units, using the ISO
 * 4217 exponent of `currency`: `toMinorUnits("15.00", "USD")` is `1500`,
 * `toMinorUnits(1500, "JPY")` is `1500`, `toMinorUnits("1.234", "KWD")` is
 * `1234`.
 *
 * Pass a string when you have one (it is exact). A number is read through its
 * shortest decimal form, so `19.99` is `1999`. An amount with more precision
 * than the currency has (`"9.999"` USD), a negative amount, or a non-number
 * throws a `RangeError`: the helper never rounds money silently.
 */
export function toMinorUnits(amount: number | string, currency: string): number {
  const exponent = currencyExponent(currency);
  let text: string;
  if (typeof amount === "number") {
    if (!Number.isFinite(amount)) throw invalidAmount(amount);
    text = String(amount);
  } else if (typeof amount === "string") {
    text = amount.trim();
  } else {
    throw invalidAmount(amount);
  }
  const m = DECIMAL.exec(text);
  if (!m) throw invalidAmount(amount);
  const whole = m[1]!;
  const fraction = m[2] ?? "";
  const shift = exponent + Number(m[3] ?? 0);
  // digits * 10^(shift - fraction.length), done on the digit string.
  let digits = (whole + fraction).replace(/^0+(?=\d)/, "");
  const scale = shift - fraction.length;
  if (scale >= 0) {
    digits = digits + "0".repeat(scale);
  } else {
    const cut = digits.length + scale;
    const dropped = cut > 0 ? digits.slice(cut) : digits;
    if (/[1-9]/.test(dropped)) throw invalidAmount(amount);
    digits = cut > 0 ? digits.slice(0, cut) : "0";
  }
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) throw invalidAmount(amount);
  return value;
}

function invalidAmount(amount: unknown): RangeError {
  return new RangeError(
    `[whisperr] invalid amount "${String(amount)}" — expected a non-negative decimal with at most the currency's minor digits`,
  );
}
