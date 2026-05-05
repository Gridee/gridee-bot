import { Redis } from 'ioredis';
import { isScreenId } from '../core/screen-id.js';

function nowMs() {
  return Date.now();
}

export class RedisSessionStore {
  constructor({ url, ttlSeconds = 1800 } = {}) {
    this.redis = new Redis(url);
    this.redis.on('error', (err) => console.error('Redis SessionStore Error:', err));
    this.ttlSeconds = ttlSeconds;
    this.prefix = 'gridee:session:';
  }

  async get(phone) {
    const data = await this.redis.get(`${this.prefix}${phone}`);
    if (!data) return null;
    return JSON.parse(data);
  }

  async set(phone, session) {
    if (!session || !isScreenId(session.step)) {
      throw new Error(`Invalid session step: ${session?.step}`);
    }
    const value = {
      role: session.role ?? null,
      activeCommand: session.activeCommand ?? null,
      step: session.step,
      data: session.data ?? {},
      createdAt: session.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.redis.setex(`${this.prefix}${phone}`, this.ttlSeconds, JSON.stringify(value));
    return value;
  }

  async clear(phone) {
    await this.redis.del(`${this.prefix}${phone}`);
  }
}

export class RedisIdempotencyStore {
  constructor({ url, ttlSeconds = 86400 } = {}) {
    this.redis = new Redis(url);
    this.redis.on('error', (err) => console.error('Redis IdempotencyStore Error:', err));
    this.ttlSeconds = ttlSeconds;
    this.prefix = 'gridee:idempotency:';
  }

  async has(key) {
    const exists = await this.redis.exists(`${this.prefix}${key}`);
    return exists === 1;
  }

  async remember(key) {
    await this.redis.setex(`${this.prefix}${key}`, this.ttlSeconds, '1');
  }
}

export class InMemorySessionStore {
  constructor({ ttlSeconds = 1800 } = {}) {
    this.ttlMs = ttlSeconds * 1000;
    this.sessions = new Map();
  }

  async get(phone) {
    const entry = this.sessions.get(phone);
    if (!entry) return null;
    if (entry.expiresAt <= nowMs()) {
      this.sessions.delete(phone);
      return null;
    }
    return structuredClone(entry.value);
  }

  async set(phone, session) {
    if (!session || !isScreenId(session.step)) {
      throw new Error(`Invalid session step: ${session?.step}`);
    }
    const value = {
      role: session.role ?? null,
      activeCommand: session.activeCommand ?? null,
      step: session.step,
      data: session.data ?? {},
      createdAt: session.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(phone, {
      value,
      expiresAt: nowMs() + this.ttlMs,
    });
    return structuredClone(value);
  }

  async clear(phone) {
    this.sessions.delete(phone);
  }
}

export class InMemoryIdempotencyStore {
  constructor({ ttlSeconds = 86400 } = {}) {
    this.ttlMs = ttlSeconds * 1000;
    this.items = new Map();
  }

  async has(key) {
    const entry = this.items.get(key);
    if (!entry) return false;
    if (entry.expiresAt <= nowMs()) {
      this.items.delete(key);
      return false;
    }
    return true;
  }

  async remember(key) {
    this.items.set(key, { expiresAt: nowMs() + this.ttlMs });
  }
}
