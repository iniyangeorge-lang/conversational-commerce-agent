// Session state for the Phase 4 agent.
//
// Redis is the production-shaped store required by the build plan. The small
// RESP client below avoids adding another runtime dependency to the hackathon
// prototype. If Redis is unavailable, SessionStore falls back to memory so the
// agent can still be run locally and tested without infrastructure.

import net from "node:net";

const SESSION_TTL_SECONDS = 60 * 60 * 24;

function encodeCommand(parts) {
  // RESP array: *<count>\r\n then a bulk string ($<len>\r\n<data>\r\n) per part.
  return `*${parts.length}\r\n${parts.map((part) => `$${Buffer.byteLength(String(part))}\r\n${part}\r\n`).join("")}`;
}

function tryDecode(buffer) {
  if (!buffer.length) return null;
  const prefix = buffer[0];
  const lineEnd = buffer.indexOf("\r\n");
  if (lineEnd < 0) return null;
  const line = buffer.subarray(1, lineEnd).toString();
  if (prefix === 43 || prefix === 45 || prefix === 58) {
    return { value: prefix === 45 ? new Error(line) : line, bytes: lineEnd + 2 };
  }
  if (prefix === 36) {
    const length = Number(line);
    if (length === -1) return { value: null, bytes: lineEnd + 2 };
    const start = lineEnd + 2;
    const end = start + length;
    if (buffer.length < end + 2) return null;
    return { value: buffer.subarray(start, end).toString(), bytes: end + 2 };
  }
  return { value: new Error(`unsupported Redis response: ${String.fromCharCode(prefix)}`), bytes: buffer.length };
}

class RedisClient {
  constructor(url) {
    const parsed = new URL(url);
    this.host = parsed.hostname;
    this.port = Number(parsed.port || 6379);
    this.password = parsed.password ? decodeURIComponent(parsed.password) : null;
    this.database = parsed.pathname && parsed.pathname !== "/" ? Number(parsed.pathname.slice(1)) : null;
  }

  command(parts) {
    const commands = [];
    if (this.password) commands.push(["AUTH", this.password]);
    if (this.database !== null && Number.isInteger(this.database)) commands.push(["SELECT", this.database]);
    commands.push(parts);

    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      let buffer = Buffer.alloc(0);
      let index = 0;
      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (err) reject(err);
        else resolve(value);
      };
      const sendNext = () => {
        if (index >= commands.length) return;
        socket.write(encodeCommand(commands[index++]));
      };
      socket.setTimeout(1200, () => finish(new Error("Redis connection timed out")));
      socket.on("connect", sendNext);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
          const decoded = tryDecode(buffer);
          if (!decoded) return;
          buffer = buffer.subarray(decoded.bytes);
          if (decoded.value instanceof Error) return finish(decoded.value);
          if (index < commands.length) sendNext();
          else return finish(null, decoded.value);
        }
      });
      socket.on("error", (err) => finish(err));
      socket.on("close", () => {
        if (!settled) finish(new Error("Redis connection closed"));
      });
    });
  }

  async get(key) {
    return this.command(["GET", key]);
  }

  async set(key, value, ttlSeconds = SESSION_TTL_SECONDS) {
    return this.command(["SET", key, value, "EX", ttlSeconds]);
  }
}

export class MemoryStore {
  constructor() {
    this.values = new Map();
  }

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async set(key, value) {
    this.values.set(key, value);
  }
}

export class SessionStore {
  constructor({ redisUrl = process.env.REDIS_URL, memory = new MemoryStore() } = {}) {
    this.memory = memory;
    this.redis = null;
    this.redisDisabled = false;
    if (redisUrl) {
      try {
        this.redis = new RedisClient(redisUrl);
      } catch (err) {
        this.redisDisabled = true;
        console.warn(`[agent] invalid REDIS_URL (${err.message}) - using memory sessions`);
      }
    } else {
      this.redisDisabled = true;
    }
  }

  async get(key) {
    if (this.redis && !this.redisDisabled) {
      try {
        const value = await this.redis.get(key);
        if (value !== null) return value;
      } catch (err) {
        this.redisDisabled = true;
        console.warn(`[agent] Redis unavailable (${err.message}) - using memory sessions`);
      }
    }
    return this.memory.get(key);
  }

  async set(key, value) {
    await this.memory.set(key, value);
    if (this.redis && !this.redisDisabled) {
      try {
        await this.redis.set(key, value);
      } catch (err) {
        this.redisDisabled = true;
        console.warn(`[agent] Redis unavailable (${err.message}) - using memory sessions`);
      }
    }
  }
}

export function sessionKey(sessionId) {
  return `cca:agent:session:${sessionId}`;
}

export function createSession(sessionId, merchantId, merchant) {
  return {
    session_id: sessionId,
    merchant_id: merchantId,
    merchant,
    state: "browsing",
    cart: {
      cart_id: `cart_${sessionId}`,
      session_id: sessionId,
      merchant_id: merchantId,
      items: [],
      subtotal: 0,
    },
    history: [],
    last_search: [],
    checkout_intent: false,
    checkout_preview: null,
    payment_token: null,
    card_last4: null,
    total_spent: 0,
    charge_attempt: 0,
    checkout_result: null,
  };
}
