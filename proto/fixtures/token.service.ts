import { createHmac } from "node:crypto";
import type { TokenPayload } from "./types.js";

/**
 * Minimal secret used by the stub HMAC signer.
 * In production this comes from an environment variable / secrets manager.
 */
const SIGNING_SECRET = process.env["JWT_SECRET"] ?? "dev-secret-do-not-use";

/**
 * Base64url-encode a string (URL-safe, no padding).
 */
function b64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Handles signing, verification, and refresh of JWT-style access and refresh tokens.
 *
 * This is a lightweight stub implementation — it uses HMAC-SHA256 and does not
 * depend on an external JWT library, keeping the fixture self-contained.
 */
export class TokenService {
  /**
   * Sign a payload and produce a compact token string.
   *
   * @param payload   - Data to embed in the token (sub, email, roles).
   * @param expiresIn - Lifetime in seconds (e.g. 3600 for 1 hour).
   * @returns           Signed token in `header.payload.signature` format.
   *
   * @example
   * ```ts
   * const token = tokenService.sign({ sub: "usr_123", email: "a@b.com", roles: ["admin"] }, 3600);
   * ```
   */
  sign(payload: Omit<TokenPayload, "iat" | "exp">, expiresIn: number): string {
    const now = Math.floor(Date.now() / 1000);
    const fullPayload: TokenPayload = {
      ...payload,
      iat: now,
      exp: now + expiresIn,
    };

    const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = b64url(JSON.stringify(fullPayload));
    const unsigned = `${header}.${body}`;
    const signature = createHmac("sha256", SIGNING_SECRET)
      .update(unsigned)
      .digest("base64url");

    return `${unsigned}.${signature}`;
  }

  /**
   * Verify a token's signature and expiry.
   *
   * @param token - The compact token string produced by `sign`.
   * @returns       The decoded TokenPayload if the token is valid.
   * @throws        Error if the signature is invalid or the token has expired.
   */
  verify(token: string): TokenPayload {
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new Error("Malformed token: expected 3 dot-separated segments");
    }

    const [header, body, signature] = parts as [string, string, string];
    const unsigned = `${header}.${body}`;
    const expected = createHmac("sha256", SIGNING_SECRET)
      .update(unsigned)
      .digest("base64url");

    if (signature !== expected) {
      throw new Error("Token signature verification failed");
    }

    const payload: TokenPayload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8")
    );

    if (payload.exp < Math.floor(Date.now() / 1000)) {
      throw new Error("Token has expired");
    }

    return payload;
  }

  /**
   * Issue a new short-lived access token from a valid refresh token.
   *
   * @param token - A refresh token produced by `sign` with `isRefresh: true`.
   * @returns       A new access token with a 1-hour lifetime.
   * @throws        Error if the provided token is not a refresh token.
   */
  refresh(token: string): string {
    const payload = this.verify(token);

    if (!payload.isRefresh) {
      throw new Error("Provided token is not a refresh token");
    }

    return this.sign(
      { sub: payload.sub, email: payload.email, roles: payload.roles },
      3600
    );
  }
}
