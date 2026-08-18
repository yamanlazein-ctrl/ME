import { SignJWT, jwtVerify, JWTPayload } from "jose";
import { config } from "../config/env.js";

const secret = new TextEncoder().encode(config.JWT_SECRET);

export interface TokenPayload extends JWTPayload {
  sub: string; // user id
  tenantId: string;
  role: string;
  permissions?: string[];
  jti: string;
  type: "access" | "refresh";
}

export class JwtSigner {
  async signAccessToken(payload: Omit<TokenPayload, "iat" | "exp" | "type">): Promise<string> {
    return new SignJWT({ ...payload, type: "access" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + Math.floor(config.JWT_EXPIRY_MS / 1000))
      .sign(secret);
  }

  async signRefreshToken(payload: Omit<TokenPayload, "iat" | "exp" | "type">): Promise<string> {
    return new SignJWT({ ...payload, type: "refresh" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(
        Math.floor(Date.now() / 1000) + Math.floor(config.REFRESH_TOKEN_EXPIRY_MS / 1000),
      )
      .sign(secret);
  }

  async verify(token: string): Promise<TokenPayload> {
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
    return payload as TokenPayload;
  }

  async verifyAccessToken(token: string): Promise<TokenPayload> {
    const payload = await this.verify(token);
    if (payload.type !== "access") {
      throw new Error("Invalid token type: expected access token");
    }
    return payload;
  }
}
