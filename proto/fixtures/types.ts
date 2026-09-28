/**
 * Shared domain interfaces for the billing and auth modules.
 *
 * These types are referenced by InvoiceService, TaxCalculator, and TokenService.
 */

/**
 * A line item on an invoice. Each item has a name, quantity, and unit price.
 */
export interface InvoiceItem {
  /** Unique SKU or product identifier */
  id: string;
  /** Human-readable product or service name */
  name: string;
  /** Number of units purchased */
  quantity: number;
  /** Price per unit in minor currency units (e.g. cents) */
  unitPrice: number;
}

/**
 * Represents a complete invoice with line items, tax, and status.
 */
export interface Invoice {
  /** Unique invoice identifier (e.g. INV-2026-0001) */
  id: string;
  /** Customer account identifier */
  customerId: string;
  /** Ordered list of line items */
  items: InvoiceItem[];
  /** Subtotal before tax, in minor currency units */
  subtotal: number;
  /** Tax amount applied, in minor currency units */
  taxAmount: number;
  /** Total amount due (subtotal + taxAmount) */
  total: number;
  /** ISO 3166-1 alpha-2 region code used for tax calculation */
  region: string;
  /** Current lifecycle status of the invoice */
  status: "draft" | "issued" | "paid" | "cancelled";
  /** ISO 8601 timestamp when the invoice was created */
  createdAt: string;
  /** ISO 8601 timestamp when the invoice was last updated */
  updatedAt: string;
}

/**
 * A tax rate entry for a given region.
 */
export interface TaxRate {
  /** ISO 3166-1 alpha-2 region code */
  region: string;
  /** Tax rate as a decimal fraction (e.g. 0.23 for 23% VAT) */
  rate: number;
  /** Human-readable label for the tax type (e.g. "VAT", "GST") */
  label: string;
}

/**
 * The decoded payload carried inside a JWT access or refresh token.
 */
export interface TokenPayload {
  /** Subject — typically the user's UUID */
  sub: string;
  /** User's primary email address */
  email: string;
  /** Assigned roles for RBAC checks */
  roles: string[];
  /** Issued-at Unix timestamp (seconds) */
  iat: number;
  /** Expiry Unix timestamp (seconds) */
  exp: number;
  /** Whether this token is a refresh token */
  isRefresh?: boolean;
}
