export interface TaxRate {
  region: string
  rate: number
}

export interface TaxResult {
  base: number
  tax: number
  total: number
  region: string
}

export class TaxCalculator {
  private rates: Map<string, number>

  constructor(rates: TaxRate[] = []) {
    this.rates = new Map(rates.map(r => [r.region, r.rate]))
    // default EU VAT fallback
    if (!this.rates.has('default')) {
      this.rates.set('default', 0.2)
    }
  }

  calculate(amount: number, region: string): TaxResult {
    const rate = this.rates.get(region) ?? this.rates.get('default') ?? 0.2
    const tax = Math.round(amount * rate * 100) / 100
    return {
      base: amount,
      tax,
      total: amount + tax,
      region,
    }
  }

  addRate(region: string, rate: number): void {
    if (rate < 0 || rate > 1) {
      throw new RangeError(`Tax rate must be between 0 and 1, got ${rate}`)
    }
    this.rates.set(region, rate)
  }

  listRegions(): string[] {
    return [...this.rates.keys()]
  }
}
