/**
 * Size-bounded in-memory cache for folder listings.
 *
 * Pure and framework-free: the caller owns freshness (each `CachedListing`
 * carries the `Date.now()` at which it was fetched) and the byte budget is a
 * getter, so a settings change takes effect on the next operation. Nothing here
 * touches disk, `localStorage` or the network.
 */

import type { ObjectEntry } from "@/types";

export interface CachedListing {
  entries: ObjectEntry[];
  truncated: boolean;
  warning: string | null;
  /** `Date.now()` at the moment the listing finished. */
  fetchedAt: number;
}

/** Per-entry bookkeeping cost: the object, its fields and the map entry. */
const ENTRY_OVERHEAD_BYTES = 160;

/** A UTF-16 unit is two bytes, which is how V8 stores a string's characters. */
const STRING_BYTES = 2;

/** The cache key for one folder listing: the same prefix in two connections is two entries. */
export function listingCacheKey(connectionId: string, prefix: string): string {
  return JSON.stringify([connectionId, prefix]);
}

/**
 * Estimate how much a listing costs in memory.
 *
 * This is a deliberate underestimate used for bounding, not an exact heap
 * measurement: it counts the fixed per-entry overhead plus the string bodies the
 * listing exposes. Object headers, array slack and hidden classes are ignored.
 */
export function estimateListingBytes(entries: ObjectEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    total += ENTRY_OVERHEAD_BYTES;
    total += STRING_BYTES * (entry.key.length + entry.name.length);
    total += STRING_BYTES * (entry.lastModified?.length ?? 0);
    total += STRING_BYTES * (entry.etag?.length ?? 0);
    total += STRING_BYTES * (entry.storageClass?.length ?? 0);
    total += STRING_BYTES * entry.kind.length;
  }
  return total;
}

interface CachedEntry {
  listing: CachedListing;
  bytes: number;
}

/** A least-recently-used cache of listings, bounded by a live byte budget. */
export class ListingCache {
  private readonly limitBytes: () => number;
  /** Insertion order is the recency order: a hit re-inserts the entry at the end. */
  private readonly entries = new Map<string, CachedEntry>();
  private usedBytes = 0;

  constructor(limitBytes: () => number) {
    this.limitBytes = limitBytes;
  }

  private limit(): number {
    const value = this.limitBytes();
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  }

  get(key: string): CachedListing | null {
    if (this.limit() === 0) return null;
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.listing;
  }

  set(key: string, listing: CachedListing): boolean {
    // A new result replaces the old one even when the new one is too large to keep.
    this.delete(key);

    const limit = this.limit();
    const bytes = estimateListingBytes(listing.entries);
    if (limit === 0 || bytes > limit) return false;

    while (this.usedBytes + bytes > limit) {
      if (!this.evictOldest()) break;
    }

    this.entries.set(key, { listing, bytes });
    this.usedBytes += bytes;
    return true;
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.usedBytes -= entry.bytes;
  }

  clear(): void {
    this.entries.clear();
    this.usedBytes = 0;
  }

  trim(): void {
    const limit = this.limit();
    if (limit === 0) {
      this.clear();
      return;
    }
    while (this.usedBytes > limit) {
      if (!this.evictOldest()) break;
    }
  }

  get bytes(): number {
    return this.usedBytes;
  }

  get size(): number {
    return this.entries.size;
  }

  /** The first key of a Map is the least recently inserted or re-read one. */
  private evictOldest(): boolean {
    const oldest = this.entries.keys().next();
    if (oldest.done) return false;
    this.delete(oldest.value);
    return true;
  }
}
