import { TaxCalculator } from "./tax-calculator.js";
import type { Invoice, InvoiceItem } from "./types.js";

/**
 * In-memory invoice store used by the fixture.
 * A real implementation would use a database repository.
 */
const invoiceStore = new Map<string, Invoice>();

/**
 * Generates sequential invoice identifiers in the format INV-YYYY-NNNN.
 */
function generateInvoiceNumber(): string {
  const year = new Date().getFullYear();
  const seq = String(invoiceStore.size + 1).padStart(4, "0");
  return `INV-${year}-${seq}`;
}

/**
 * Application service that manages the full lifecycle of invoices.
 *
 * Coordinates between the domain model (Invoice, InvoiceItem) and the
 * TaxCalculator utility. Does not handle persistence itself — it delegates
 * to an injected store in a real application.
 */
export class InvoiceService {
  private readonly taxCalculator: TaxCalculator;

  constructor() {
    this.taxCalculator = new TaxCalculator();
  }

  /**
   * Issue a new invoice for a customer.
   *
   * Calculates the subtotal from the provided line items, computes the
   * applicable tax via TaxCalculator, and persists the resulting Invoice.
   *
   * @param customerId - Unique identifier of the customer being billed.
   * @param items      - One or more InvoiceItem line items to include.
   * @param region     - ISO 3166-1 alpha-2 region code for tax calculation.
   * @returns            The newly created Invoice in "issued" status.
   *
   * @throws Error if no items are provided.
   *
   * @example
   * ```ts
   * const invoice = await invoiceService.issue("cust_abc", [
   *   { id: "sku_001", name: "Widget Pro", quantity: 2, unitPrice: 4999 }
   * ], "PL");
   * ```
   */
  async issue(
    customerId: string,
    items: InvoiceItem[],
    region: string = "US"
  ): Promise<Invoice> {
    if (!items.length) {
      throw new Error("Cannot issue an invoice with no line items");
    }

    const subtotal = items.reduce(
      (sum, item) => sum + item.quantity * item.unitPrice,
      0
    );
    const taxAmount = this.taxCalculator.calculate(subtotal, region);
    const now = new Date().toISOString();

    const invoice: Invoice = {
      id: generateInvoiceNumber(),
      customerId,
      items,
      subtotal,
      taxAmount,
      total: subtotal + taxAmount,
      region,
      status: "issued",
      createdAt: now,
      updatedAt: now,
    };

    invoiceStore.set(invoice.id, invoice);
    return invoice;
  }

  /**
   * Cancel an existing invoice.
   *
   * Only invoices in "issued" status can be cancelled. Paid invoices require
   * a refund workflow instead.
   *
   * @param invoiceId - The unique identifier of the invoice to cancel.
   * @returns           The updated Invoice with status set to "cancelled".
   *
   * @throws Error if the invoice does not exist.
   * @throws Error if the invoice is not in "issued" status.
   */
  async cancel(invoiceId: string): Promise<Invoice> {
    const invoice = await this.getById(invoiceId);

    if (invoice.status !== "issued") {
      throw new Error(
        `Cannot cancel invoice ${invoiceId} with status "${invoice.status}"`
      );
    }

    const updated: Invoice = {
      ...invoice,
      status: "cancelled",
      updatedAt: new Date().toISOString(),
    };

    invoiceStore.set(invoiceId, updated);
    return updated;
  }

  /**
   * Retrieve a single invoice by its identifier.
   *
   * @param invoiceId - The unique invoice ID (e.g. "INV-2026-0001").
   * @returns           The matching Invoice record.
   *
   * @throws Error if no invoice with the given ID exists.
   */
  async getById(invoiceId: string): Promise<Invoice> {
    const invoice = invoiceStore.get(invoiceId);
    if (!invoice) {
      throw new Error(`Invoice not found: ${invoiceId}`);
    }
    return invoice;
  }
}
