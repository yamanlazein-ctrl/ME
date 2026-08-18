import { Redis } from "ioredis";
import { config } from "../config/env.js";

export const redis = config.REDIS_URL ? new Redis(config.REDIS_URL) : null;

export async function checkRedis(): Promise<boolean> {
  if (!redis) return false;
  try {
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}

export class RedisTokenDenylist {
  constructor(private readonly redis: Redis | null) {}

  async add(jti: string, ttlSeconds: number): Promise<void> {
    if (!this.redis) return;
    await this.redis.setex(`denylist:${jti}`, ttlSeconds, "1");
  }

  async has(jti: string): Promise<boolean> {
    if (!this.redis) return false;
    const result = await this.redis.get(`denylist:${jti}`);
    return result === "1";
  }

  async delete(jti: string): Promise<void> {
    if (!this.redis) return;
    await this.redis.del(`denylist:${jti}`);
  }
}
