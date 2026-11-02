import { describe, expect, it } from 'vitest';
import { BOUNCE_GAP_US, ContactTracker } from './contacts.ts';

describe('ContactTracker', () => {
  it('counts the first touch, then nothing while the contact lasts', () => {
    const t = new ContactTracker();
    expect(t.started('a', 0)).toBe(true);
    expect(t.started('a', 5_000)).toBe(false); // a second collider of the same target
    t.stopped('a', 10_000);
    t.stopped('a', 10_000);
    expect(t.started('a', 1_000_000)).toBe(true);
  });

  it('treats a re-touch within the bounce gap as the same hit, and one after it as a new hit', () => {
    const t = new ContactTracker();
    expect(t.started('a', 0)).toBe(true);
    t.stopped('a', 1_000);
    expect(t.started('a', 1_000 + BOUNCE_GAP_US - 1)).toBe(false);
    t.stopped('a', 30_000);
    expect(t.started('a', 30_000 + BOUNCE_GAP_US)).toBe(true);
  });

  it('keeps a short gap: a second hit well inside 250 ms counts', () => {
    expect(BOUNCE_GAP_US).toBeLessThanOrEqual(20_000);
  });

  it('tracks targets separately, so the opposite wall edge right after is a second hit', () => {
    const t = new ContactTracker();
    expect(t.started('wall:left', 0)).toBe(true);
    t.stopped('wall:left', 2_000);
    expect(t.started('wall:right', 4_000)).toBe(true);
    expect(t.started('wall:left', 5_000)).toBe(false); // same edge again: a bounce
  });

  it('starts afresh for a forgotten target', () => {
    const t = new ContactTracker();
    expect(t.started('a', 0)).toBe(true);
    t.stopped('a', 1_000);
    t.forget('a');
    expect(t.started('a', 2_000)).toBe(true);
    t.forget('a');
    expect(t.started('a', 3_000)).toBe(true); // forgotten while still touching
  });
});
