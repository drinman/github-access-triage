import { Redis } from "@upstash/redis";

export interface KeyValueStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  setIfAbsent<T>(
    key: string,
    value: T,
    ttlSeconds: number,
  ): Promise<boolean>;
  compareAndSet<T>(
    key: string,
    expected: T,
    next: T,
    ttlSeconds?: number,
  ): Promise<boolean>;
  compareAndDelete<T>(key: string, expected: T): Promise<boolean>;
  delete(key: string): Promise<void>;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode<T>(value: string | null): T | null {
  if (value === null) {
    return null;
  }
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
}

export class UpstashStore implements KeyValueStore {
  private redis: Redis | null = null;

  private client(): Redis {
    if (!this.redis) {
      this.redis = Redis.fromEnv();
    }
    return this.redis;
  }

  async get<T>(key: string): Promise<T | null> {
    const value = await this.client().get<string>(key);
    return decode<T>(value);
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client().set(key, encode(value), { ex: ttlSeconds });
      return;
    }
    await this.client().set(key, encode(value));
  }

  async setIfAbsent<T>(
    key: string,
    value: T,
    ttlSeconds: number,
  ): Promise<boolean> {
    const result = await this.client().set(key, encode(value), {
      ex: ttlSeconds,
      nx: true,
    });
    return result === "OK";
  }

  async compareAndSet<T>(
    key: string,
    expected: T,
    next: T,
    ttlSeconds?: number,
  ): Promise<boolean> {
    const script = this.client().createScript<number>(
      [
        'if redis.call("get", KEYS[1]) == ARGV[1] then',
        '  if ARGV[3] ~= "" then',
        '    redis.call("set", KEYS[1], ARGV[2], "EX", ARGV[3])',
        "  else",
        '    redis.call("set", KEYS[1], ARGV[2])',
        "  end",
        "  return 1",
        "end",
        "return 0",
      ].join("\n"),
    );
    const result = await script.eval(
      [key],
      [
        encode(expected),
        encode(next),
        ttlSeconds === undefined ? "" : String(ttlSeconds),
      ],
    );
    return result === 1;
  }

  async compareAndDelete<T>(key: string, expected: T): Promise<boolean> {
    const script = this.client().createScript<number>(
      [
        'if redis.call("get", KEYS[1]) == ARGV[1] then',
        '  return redis.call("del", KEYS[1])',
        "end",
        "return 0",
      ].join("\n"),
    );
    const result = await script.eval([key], [encode(expected)]);
    return result === 1;
  }

  async delete(key: string): Promise<void> {
    await this.client().del(key);
  }
}

type MemoryEntry = {
  encoded: string;
  expiresAt: number | null;
};

export class MemoryStore implements KeyValueStore {
  private readonly entries = new Map<string, MemoryEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  private current(key: string): MemoryEntry | null {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  async get<T>(key: string): Promise<T | null> {
    return decode<T>(this.current(key)?.encoded ?? null);
  }

  async set<T>(
    key: string,
    value: T,
    ttlSeconds?: number,
  ): Promise<void> {
    this.entries.set(key, {
      encoded: encode(value),
      expiresAt: ttlSeconds ? this.now() + ttlSeconds * 1000 : null,
    });
  }

  async setIfAbsent<T>(
    key: string,
    value: T,
    ttlSeconds: number,
  ): Promise<boolean> {
    if (this.current(key)) {
      return false;
    }
    await this.set(key, value, ttlSeconds);
    return true;
  }

  async compareAndSet<T>(
    key: string,
    expected: T,
    next: T,
    ttlSeconds?: number,
  ): Promise<boolean> {
    if (this.current(key)?.encoded !== encode(expected)) {
      return false;
    }
    await this.set(key, next, ttlSeconds);
    return true;
  }

  async compareAndDelete<T>(key: string, expected: T): Promise<boolean> {
    if (this.current(key)?.encoded !== encode(expected)) {
      return false;
    }
    this.entries.delete(key);
    return true;
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

let defaultStore: KeyValueStore | undefined;

export function getStore(): KeyValueStore {
  defaultStore ??= new UpstashStore();
  return defaultStore;
}
