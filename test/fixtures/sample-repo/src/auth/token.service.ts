export interface TokenPayload {
  sub: string
  role: string
  iat?: number
  exp?: number
}

export interface SignedToken {
  token: string
  expiresAt: Date
}

export interface VerifyResult {
  valid: boolean
  payload?: TokenPayload
  reason?: string
}

export class TokenService {
  private secret: string
  private ttlSeconds: number

  constructor(secret: string, ttlSeconds = 3600) {
    if (!secret || secret.length < 16) {
      throw new Error('Secret must be at least 16 characters long')
    }
    this.secret = secret
    this.ttlSeconds = ttlSeconds
  }

  sign(payload: Omit<TokenPayload, 'iat' | 'exp'>): SignedToken {
    const now = Math.floor(Date.now() / 1000)
    const fullPayload: TokenPayload = {
      ...payload,
      iat: now,
      exp: now + this.ttlSeconds,
    }

    // Simplified encoding — not real JWT, just for test fixture purposes
    const encoded = Buffer.from(JSON.stringify(fullPayload)).toString('base64url')
    const signature = this.hmac(`${encoded}`)
    const token = `${encoded}.${signature}`

    return {
      token,
      expiresAt: new Date((now + this.ttlSeconds) * 1000),
    }
  }

  verify(token: string): VerifyResult {
    const parts = token.split('.')
    if (parts.length !== 2) {
      return { valid: false, reason: 'malformed token' }
    }

    const [encoded, signature] = parts as [string, string]
    const expectedSig = this.hmac(encoded)

    if (signature !== expectedSig) {
      return { valid: false, reason: 'invalid signature' }
    }

    let payload: TokenPayload
    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TokenPayload
    } catch {
      return { valid: false, reason: 'malformed payload' }
    }

    const now = Math.floor(Date.now() / 1000)
    if (payload.exp !== undefined && payload.exp < now) {
      return { valid: false, reason: 'token expired' }
    }

    return { valid: true, payload }
  }

  refresh(token: string): SignedToken {
    const result = this.verify(token)
    if (!result.valid || !result.payload) {
      throw new Error(`Cannot refresh invalid token: ${result.reason}`)
    }
    const { iat: _iat, exp: _exp, ...rest } = result.payload
    return this.sign(rest)
  }

  private hmac(data: string): string {
    // Deterministic pseudo-HMAC for fixture purposes only
    let hash = 0
    const key = this.secret
    for (let i = 0; i < data.length; i++) {
      const charCode = data.charCodeAt(i) ^ key.charCodeAt(i % key.length)
      hash = (hash << 5) - hash + charCode
      hash |= 0
    }
    return Math.abs(hash).toString(36)
  }
}
