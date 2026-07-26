import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, __internal, defaultSave, defaultSettings, recordResult } from '../../src/core/storage';
import { ACTIONS, DEFAULT_KEY_BINDINGS, bindingLabel, keyLabel } from '../../src/game/input/bindings';
import { AdaptiveQuality, QUALITY_ORDER, QUALITY_TIERS } from '../../src/render/quality';
import { formatLapTime, ordinal } from '../../src/core/math';
import { InputManager } from '../../src/game/input/InputManager';
import { buildScenery } from '../../src/render/scene/Scenery';
import { getTrack } from '../../src/game/track/tracks';
import { normalizeRacerId } from '../../src/game/racers';

const { migrate } = __internal;

/**
 * Settings, saves and migrations.
 *
 * The rule these encode: a player's preferences and records survive an upgrade.
 * Silently resetting someone's best lap because a field was renamed is the kind
 * of bug nobody reports and everybody notices.
 */

describe('save migration', () => {
  it('returns defaults for missing, empty or corrupt data', () => {
    for (const input of [undefined, null, 42, 'nonsense', [], {}]) {
      const save = migrate(input);
      expect(save.version).toBe(SCHEMA_VERSION);
      expect(save.settings.quality).toBe(defaultSettings().quality);
      expect(save.bests).toEqual({});
    }
  });

  it('spreads a version 1 single volume across the new channels', () => {
    const save = migrate({ version: 1, settings: { volume: 0.4, muted: true } });
    expect(save.settings.audio.master).toBeCloseTo(0.4, 5);
    expect(save.settings.audio.music).toBeCloseTo(0.28, 5);
    expect(save.settings.audio.effects).toBeCloseTo(0.4, 5);
    // "Quiet please" is a preference, and it survives.
    expect(save.settings.audio.muted).toBe(true);
  });

  it('keeps version 2 audio channels as they are', () => {
    const save = migrate({
      version: 2,
      settings: { audio: { master: 0.3, music: 0.1, effects: 0.9, muted: false } },
    });
    expect(save.settings.audio).toEqual({ master: 0.3, music: 0.1, effects: 0.9, muted: false });
  });

  it('clamps out-of-range values rather than trusting them', () => {
    const save = migrate({ version: 2, settings: { audio: { master: 9, music: -4, effects: 0.5 } } });
    expect(save.settings.audio.master).toBe(1);
    expect(save.settings.audio.music).toBe(0);
    expect(save.settings.audio.effects).toBe(0.5);
  });

  it('ignores values of the wrong type', () => {
    const save = migrate({
      version: 2,
      settings: { quality: 'ultra', reducedMotion: 'yes', catchUp: 1, lastTrack: 7, cameraMode: 'cinematic' },
    });
    const fallback = defaultSettings();
    expect(save.settings.quality).toBe(fallback.quality);
    expect(save.settings.reducedMotion).toBe(fallback.reducedMotion);
    expect(save.settings.catchUp).toBe(fallback.catchUp);
    expect(save.settings.lastTrack).toBe(fallback.lastTrack);
    expect(save.settings.cameraMode).toBe(fallback.cameraMode);
  });

  it('keeps saved racer ids structural for application-level validation', () => {
    const save = migrate({ version: 2, settings: { lastRacer: 'removed-racer' } });
    expect(save.settings.lastRacer).toBe('removed-racer');
    expect(normalizeRacerId(save.settings.lastRacer)).toBe(defaultSettings().lastRacer);
  });

  it('preserves best times across a migration', () => {
    const save = migrate({
      version: 1,
      settings: { volume: 0.5 },
      bests: { 'overgrown-interchange': { race: 118.4, lap: 38.2, difficulty: 'ace' } },
    });
    expect(save.bests['overgrown-interchange']).toEqual({ race: 118.4, lap: 38.2, difficulty: 'ace' });
  });

  it('drops nonsense best times without discarding the good ones', () => {
    const save = migrate({
      version: 2,
      bests: {
        good: { race: 100, lap: 30, difficulty: 'pro' },
        bad: { race: 'fast' },
        alsoBad: null,
      },
    });
    expect(save.bests.good).toBeDefined();
    expect(save.bests.bad).toBeUndefined();
    expect(save.bests.alsoBad).toBeUndefined();
  });

  it('accepts custom key bindings but rejects malformed ones', () => {
    const save = migrate({
      version: 2,
      settings: { bindings: { accelerate: ['KeyI'], brake: [], drift: 'Space', steerLeft: [5] } },
    });
    expect(save.settings.bindings.accelerate).toEqual(['KeyI']);
    expect(save.settings.bindings.brake).toEqual(DEFAULT_KEY_BINDINGS.brake);
    expect(save.settings.bindings.drift).toEqual(DEFAULT_KEY_BINDINGS.drift);
    expect(save.settings.bindings.steerLeft).toEqual(DEFAULT_KEY_BINDINGS.steerLeft);
  });
});

describe('input rebinding', () => {
  it('can cancel a pending key capture when its screen exits', () => {
    const input = new InputManager();
    input.captureNextKey(() => undefined);
    expect(input.isCapturing).toBe(true);
    input.cancelCapture();
    expect(input.isCapturing).toBe(false);
  });
});

describe('best times', () => {
  it('records an improvement and reports it', () => {
    const save = defaultSave();
    const first = recordResult(save, 'track', 120, 40, 'pro');
    expect(first).toEqual({ race: true, lap: true });

    const worse = recordResult(save, 'track', 130, 45, 'pro');
    expect(worse).toEqual({ race: false, lap: false });
    expect(save.bests.track?.race).toBe(120);
    expect(save.bests.track?.lap).toBe(40);

    const better = recordResult(save, 'track', 118, 45, 'ace');
    expect(better).toEqual({ race: true, lap: false });
    expect(save.bests.track?.race).toBe(118);
    expect(save.bests.track?.lap).toBe(40);
    expect(save.bests.track?.difficulty).toBe('ace');
  });

  it('ignores impossible times', () => {
    const save = defaultSave();
    expect(recordResult(save, 'track', 0, Infinity, 'pro')).toEqual({ race: false, lap: false });
    expect(recordResult(save, 'track', -5, NaN, 'pro')).toEqual({ race: false, lap: false });
  });
});

describe('key bindings', () => {
  it('binds every rebindable action by default', () => {
    for (const action of ACTIONS) {
      const codes = DEFAULT_KEY_BINDINGS[action.id];
      expect(codes.length, `${action.id} is unbound`).toBeGreaterThan(0);
    }
  });

  it('never binds one key to two actions', () => {
    const seen = new Map<string, string>();
    for (const [action, codes] of Object.entries(DEFAULT_KEY_BINDINGS)) {
      for (const code of codes) {
        expect(seen.has(code), `${code} is bound to both ${seen.get(code)} and ${action}`).toBe(false);
        seen.set(code, action);
      }
    }
  });

  it('always keeps Escape on pause', () => {
    expect(DEFAULT_KEY_BINDINGS.pause).toContain('Escape');
    expect(ACTIONS.find((a) => a.id === 'pause')?.rebindable).toBe(false);
  });

  it('renders readable labels', () => {
    expect(keyLabel('KeyW')).toBe('W');
    expect(keyLabel('ArrowUp')).toBe('↑');
    expect(keyLabel('ShiftLeft')).toBe('L Shift');
    expect(keyLabel('Digit3')).toBe('3');
    expect(bindingLabel(DEFAULT_KEY_BINDINGS, 'accelerate')).toBe('W or ↑');
    expect(bindingLabel({ ...DEFAULT_KEY_BINDINGS, respawn: [] }, 'respawn')).toBe('Unbound');
  });
});

describe('quality tiers', () => {
  it('keeps one batched mesh per species while scaling instance budgets', () => {
    const track = getTrack('overgrown-interchange');
    const build = (tier: 'low' | 'high') =>
      buildScenery(track, {
        densityScale: QUALITY_TIERS[tier].sceneryDensity,
        visibilityDistance: QUALITY_TIERS[tier].sceneryDistance,
        heightAt: () => 0,
        castShadows: false,
      });
    const low = build('low').group;
    const high = build('high').group;
    expect(low.children.length).toBeLessThanOrEqual(track.definition.scenery.length);
    expect(high.children.length).toBeLessThanOrEqual(track.definition.scenery.length);
    expect(low.children.reduce((sum, child) => sum + ((child as { count?: number }).count ?? 0), 0)).toBeLessThan(
      high.children.reduce((sum, child) => sum + ((child as { count?: number }).count ?? 0), 0),
    );
    expect(low.children.every((child) => child.frustumCulled)).toBe(true);
  });

  it('orders the tiers monotonically on every budget', () => {
    for (let i = 1; i < QUALITY_ORDER.length; i++) {
      const lower = QUALITY_TIERS[QUALITY_ORDER[i - 1] as 'low'];
      const higher = QUALITY_TIERS[QUALITY_ORDER[i] as 'low'];
      expect(higher.particleBudget).toBeGreaterThan(lower.particleBudget);
      expect(higher.sceneryDensity).toBeGreaterThan(lower.sceneryDensity);
      expect(higher.sceneryDistance).toBeGreaterThan(lower.sceneryDistance);
      expect(higher.maxPixelRatio).toBeGreaterThanOrEqual(lower.maxPixelRatio);
      // Smaller is more expensive for terrain resolution.
      expect(higher.terrainResolution).toBeLessThan(lower.terrainResolution);
    }
  });

  it('keeps the lowest tier genuinely cheap', () => {
    const low = QUALITY_TIERS.low;
    expect(low.shadowMapSize).toBe(0);
    expect(low.speedEffects).toBe(false);
    expect(low.maxPixelRatio).toBe(1);
  });
});

describe('adaptive quality', () => {
  const feed = (adaptive: AdaptiveQuality, frameSeconds: number, frames: number): string | null => {
    let changed: string | null = null;
    for (let i = 0; i < frames; i++) {
      const result = adaptive.sample(frameSeconds, frameSeconds);
      if (result) changed = result;
    }
    return changed;
  };

  it('drops a tier when frames are consistently slow', () => {
    const adaptive = new AdaptiveQuality('high');
    // Past the initial cooldown, then a long run of 30 fps frames.
    feed(adaptive, 1 / 30, 2000);
    expect(adaptive.tier).toBe('low');
  });

  it('raises a tier only when there is real headroom', () => {
    const adaptive = new AdaptiveQuality('low');
    feed(adaptive, 1 / 200, 2000);
    expect(adaptive.tier).toBe('high');
  });

  it('never raises again after it has had to drop', () => {
    const adaptive = new AdaptiveQuality('high');
    feed(adaptive, 1 / 30, 1000);
    const dropped = adaptive.tier;
    expect(dropped).not.toBe('high');
    feed(adaptive, 1 / 200, 4000);
    // Oscillating quality is worse than the frame rate it protects against.
    expect(adaptive.tier).toBe(dropped);
  });

  it('does nothing on a single slow frame', () => {
    const adaptive = new AdaptiveQuality('high');
    feed(adaptive, 1 / 120, 200);
    expect(adaptive.sample(0.3, 0.3)).toBeNull();
    expect(adaptive.tier).toBe('high');
  });
});

describe('formatting', () => {
  it('formats lap times consistently', () => {
    expect(formatLapTime(0)).toBe('0:00.000');
    expect(formatLapTime(65.5)).toBe('1:05.500');
    expect(formatLapTime(3599.999)).toBe('59:59.999');
    expect(formatLapTime(Infinity)).toBe('--:--.---');
    expect(formatLapTime(-1)).toBe('--:--.---');
    expect(formatLapTime(NaN)).toBe('--:--.---');
  });

  it('formats ordinals, including the teens', () => {
    expect(['x', ordinal(1), ordinal(2), ordinal(3), ordinal(4)].join(' ')).toBe('x 1st 2nd 3rd 4th');
    expect([ordinal(11), ordinal(12), ordinal(13)].join(' ')).toBe('11th 12th 13th');
    expect([ordinal(21), ordinal(22), ordinal(101)].join(' ')).toBe('21st 22nd 101st');
  });
});
