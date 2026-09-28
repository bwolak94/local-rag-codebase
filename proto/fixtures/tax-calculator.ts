import type { TaxRate } from "./types.js";

/**
 * Tax rate table keyed by ISO 3166-1 alpha-2 region code.
 * Extend this map to support additional jurisdictions.
 */
const TAX_RATES: Record<string, TaxRate> = {
  PL: { region: "PL", rate: 0.23, label: "VAT" },
  DE: { region: "DE", rate: 0.19, label: "MwSt" },
  US: { region: "US", rate: 0.0875, label: "Sales Tax" },
  GB: { region: "GB", rate: 0.2, label: "VAT" },
  FR: { region: "FR", rate: 0.2, label: "TVA" },
};

/**
 * Stateless utility that computes tax amounts and looks up regional rates.
 *
 * All monetary values use minor currency units (e.g. cents) to avoid
 * floating-point rounding errors.
 */
export class TaxCalculator {
  /**
   * Calculate the tax amount for a given subtotal and region.
   *
   * @param subtotal - Pre-tax amount in minor currency units (e.g. cents).
   * @param region   - ISO 3166-1 alpha-2 country code (e.g. "PL", "DE").
   * @returns         Tax amount in minor currency units, rounded to the nearest integer.
   *
   * @example
   * ```ts
   * const tax = calculator.calculate(10000, "PL"); // 2300 (23% of 100.00)
   * ```
   */
  calculate(subtotal: number, region: string): number {
    const rate = this.getRate(region);
    return Math.round(subtotal * rate.rate);
  }

  /**
   * Retrieve the full TaxRate record for the given region.
   *
   * Falls back to a 0% rate when the region is not found so that invoice
   * creation never hard-fails due to a missing tax table entry.
   *
   * @param region - ISO 3166-1 alpha-2 country code.
   * @returns        The matching TaxRate, or a zero-rate sentinel.
   */
  private getRate(region: string): TaxRate {
    const entry = TAX_RATES[region.toUpperCase()];
    if (!entry) {
      return { region, rate: 0, label: "N/A" };
    }
    return entry;
  }
}
