import { TaxCalculator } from './tax-calculator.js'

export interface InvoiceLineItem {
  description: string
  quantity: number
  unitPrice: number
}

export interface Invoice {
  id: string
  customerId: string
  region: string
  lineItems: InvoiceLineItem[]
  subtotal: number
  tax: number
  total: number
  issuedAt: Date
}

export class InvoiceService {
  private taxCalculator: TaxCalculator

  constructor(taxCalculator?: TaxCalculator) {
    this.taxCalculator = taxCalculator ?? new TaxCalculator()
  }

  issue(customerId: string, region: string, lineItems: InvoiceLineItem[]): Invoice {
    const subtotal = lineItems.reduce(
      (sum, item) => sum + item.quantity * item.unitPrice,
      0,
    )

    const taxResult = this.taxCalculator.calculate(subtotal, region)

    return {
      id: this.generateId(),
      customerId,
      region,
      lineItems,
      subtotal,
      tax: taxResult.tax,
      total: taxResult.total,
      issuedAt: new Date(),
    }
  }

  private generateId(): string {
    return `INV-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
  }

  recalculate(invoice: Invoice): Invoice {
    return this.issue(invoice.customerId, invoice.region, invoice.lineItems)
  }
}
