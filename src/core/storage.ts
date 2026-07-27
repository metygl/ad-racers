import { DEFAULT_AUDIO } from '../audio/AudioEngine';
import type { AudioSettings } from '../audio/AudioEngine';
import { DEFAULT_KEY_BINDINGS } from '../game/input/bindings';
import type { KeyBindings } from '../game/input/bindings';
import type { CameraMode } from '../render/camera/ChaseCamera';
import type { QualityId } from '../render/quality';

/**
 * Local settings, best times and Circuit records.
 *
 * Only preferences and results the player earned are stored. No identifiers,
 * no analytics, nothing that leaves the machine. Everything lives under one
 * key so clearing it is one action, and the schema is versioned so an old save
 * is migrated rather than discarded - losing someone's records because a field
 * was renamed is not acceptable.
 */

export const STORAGE_KEY = 'ad-racers';
export const SCHEMA_VERSION = 3;

export interface BestTime {
  /** Best full-race time, seconds. */
  race: number;
  /** Best single lap, seconds. */
  lap: number;
  /** Difficulty the best race time was set on. */
  difficulty: string;
  /** Speed class the best race time was set at. */
  speedClass?: string;
}

/**
 * A completed championship, kept per (difficulty, speed class) pair.
 *
 * Stored as the best result rather than a history: a player wants to know
 * whether they have won the Circuit at Ace on the fastest class, not what they
 * scored on a Tuesday. Keeping one row per pair is also what makes the unlock
 * rule below expressible in one line.
 */
export interface CircuitRecord {
  /** Best finishing place across the whole championship, 1-based. */
  place: number;
  /** Points scored in that championship. */
  points: number;
  /** Total time across every round, seconds. */
  totalTime: number;
}

export interface GameSettings {
  quality: QualityId;
  /** `auto` lets the adaptive monitor pick and adjust. */
  autoQuality: boolean;
  audio: AudioSettings;
  bindings: KeyBindings;
  reducedMotion: boolean;
  highContrast: boolean;
  /** Whether the bounded catch-up assist is on. */
  catchUp: boolean;
  showPerformance: boolean;
  cameraMode: CameraMode;
  lastTrack: string;
  lastRacer: string;
  lastDifficulty: string;
  /** Speed class id; see `SPEED_CLASSES` in `src/game/config.ts`. */
  lastSpeedClass: string;
  /** Set once the player has seen the controls card. */
  seenControls: boolean;
}

export interface SaveData {
  version: number;
  settings: GameSettings;
  /** Best times keyed by track id. */
  bests: Record<string, BestTime>;
  /** Championship records keyed by `${difficultyId}:${speedClassId}`. */
  circuits: Record<string, CircuitRecord>;
}

export function defaultSettings(): GameSettings {
  return {
    quality: 'medium',
    autoQuality: true,
    audio: { ...DEFAULT_AUDIO },
    bindings: structuredCloneBindings(DEFAULT_KEY_BINDINGS),
    reducedMotion: false,
    highContrast: false,
    catchUp: true,
    showPerformance: false,
    cameraMode: 'chase',
    lastTrack: 'overgrown-interchange',
    lastRacer: 'thornline',
    lastDifficulty: 'pro',
    lastSpeedClass: 'reclaim',
    seenControls: false,
  };
}

/**
 * Which speed classes the player has earned.
 *
 * The first is always available. Each later one opens once the player has
 * finished on the podium of a Circuit at the class below — a gate that is
 * deliberately about *finishing a championship*, not about grinding: three
 * podiums is one evening, and the reward is a faster game rather than a
 * cosmetic.
 *
 * Nothing is ever hidden. A locked class is shown with what unlocks it, because
 * a player deciding whether to keep playing deserves to see what is up there.
 */
export function unlockedSpeedClasses(save: SaveData, classIds: readonly string[]): Set<string> {
  const unlocked = new Set<string>();
  const first = classIds[0];
  if (first) unlocked.add(first);
  for (let i = 1; i < classIds.length; i++) {
    const previous = classIds[i - 1];
    const current = classIds[i];
    if (!previous || !current) continue;
    const earned = Object.entries(save.circuits).some(
      ([key, record]) => key.endsWith(`:${previous}`) && record.place <= 3,
    );
    if (!earned) break;
    unlocked.add(current);
  }
  return unlocked;
}

function structuredCloneBindings(bindings: KeyBindings): KeyBindings {
  const out = {} as KeyBindings;
  for (const [action, codes] of Object.entries(bindings) as [keyof KeyBindings, string[]][]) {
    out[action] = [...codes];
  }
  return out;
}

export function defaultSave(): SaveData {
  return { version: SCHEMA_VERSION, settings: defaultSettings(), bests: {}, circuits: {} };
}

/**
 * Brings any earlier save forward.
 *
 * Each step is deliberately small and additive. Version 1 predates independent
 * music and effects volumes, so a v1 save's single `volume` is spread across
 * the new channels rather than reset — the player's "quiet please" survives.
 */
function migrate(raw: unknown): SaveData {
  const save = defaultSave();
  if (typeof raw !== 'object' || raw === null) return save;
  const data = raw as Record<string, unknown>;
  const version = typeof data.version === 'number' ? data.version : 0;

  const incoming = (data.settings ?? {}) as Record<string, unknown>;

  if (version <= 1) {
    const legacyVolume = typeof incoming.volume === 'number' ? incoming.volume : null;
    if (legacyVolume !== null) {
      save.settings.audio.master = clampUnit(legacyVolume);
      save.settings.audio.music = clampUnit(legacyVolume * 0.7);
      save.settings.audio.effects = clampUnit(legacyVolume);
    }
    if (typeof incoming.muted === 'boolean') save.settings.audio.muted = incoming.muted;
  }

  // Fields that have kept their shape across versions are copied straight
  // through, guarded by a type check so a corrupt value cannot poison a run.
  copyIf(incoming, 'quality', save.settings, (v): v is QualityId => v === 'low' || v === 'medium' || v === 'high');
  copyIf(incoming, 'autoQuality', save.settings, isBoolean);
  copyIf(incoming, 'reducedMotion', save.settings, isBoolean);
  copyIf(incoming, 'highContrast', save.settings, isBoolean);
  copyIf(incoming, 'catchUp', save.settings, isBoolean);
  copyIf(incoming, 'showPerformance', save.settings, isBoolean);
  copyIf(incoming, 'seenControls', save.settings, isBoolean);
  copyIf(incoming, 'lastTrack', save.settings, isString);
  copyIf(incoming, 'lastRacer', save.settings, isString);
  copyIf(incoming, 'lastDifficulty', save.settings, isString);
  copyIf(incoming, 'lastSpeedClass', save.settings, isString);
  copyIf(
    incoming,
    'cameraMode',
    save.settings,
    (v): v is CameraMode => v === 'chase' || v === 'close' || v === 'far',
  );

  if (version >= 2 && typeof incoming.audio === 'object' && incoming.audio !== null) {
    const audio = incoming.audio as Record<string, unknown>;
    if (isNumber(audio.master)) save.settings.audio.master = clampUnit(audio.master);
    if (isNumber(audio.music)) save.settings.audio.music = clampUnit(audio.music);
    if (isNumber(audio.effects)) save.settings.audio.effects = clampUnit(audio.effects);
    if (isBoolean(audio.muted)) save.settings.audio.muted = audio.muted;
  }

  if (typeof incoming.bindings === 'object' && incoming.bindings !== null) {
    const bindings = incoming.bindings as Record<string, unknown>;
    for (const action of Object.keys(save.settings.bindings) as (keyof KeyBindings)[]) {
      const value = bindings[action];
      if (Array.isArray(value) && value.every(isString) && value.length > 0) {
        save.settings.bindings[action] = value;
      }
    }
  }

  if (typeof data.bests === 'object' && data.bests !== null) {
    for (const [track, entry] of Object.entries(data.bests as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const best = entry as Record<string, unknown>;
      if (!isNumber(best.race) && !isNumber(best.lap)) continue;
      save.bests[track] = {
        race: isNumber(best.race) && best.race > 0 ? best.race : Infinity,
        lap: isNumber(best.lap) && best.lap > 0 ? best.lap : Infinity,
        difficulty: isString(best.difficulty) ? best.difficulty : 'pro',
        // A v2 save predates speed classes, so every time in it was set at the
        // base class. Recording that is what stops an old record silently
        // claiming to have been set on a faster one.
        speedClass: isString(best.speedClass) ? best.speedClass : 'reclaim',
      };
    }
  }

  if (typeof data.circuits === 'object' && data.circuits !== null) {
    for (const [key, entry] of Object.entries(data.circuits as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (!isNumber(record.place)) continue;
      save.circuits[key] = {
        place: Math.max(1, Math.round(record.place)),
        points: isNumber(record.points) ? record.points : 0,
        totalTime: isNumber(record.totalTime) && record.totalTime > 0 ? record.totalTime : Infinity,
      };
    }
  }

  return save;
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
const clampUnit = (v: number): number => Math.min(1, Math.max(0, v));

function copyIf<T extends object, K extends Extract<keyof T, string>>(
  source: Record<string, unknown>,
  key: K,
  target: T,
  guard: (value: unknown) => value is T[K],
): void {
  const value = source[key];
  if (guard(value)) target[key] = value;
}

/**
 * Reads the save. Any failure — storage disabled, quota exceeded, corrupt JSON
 * — falls back to defaults silently, because a player in private browsing
 * should get a working game, not an error.
 */
export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultSave();
    return migrate(JSON.parse(raw));
  } catch {
    return defaultSave();
  }
}

export function saveSave(data: SaveData): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...data, version: SCHEMA_VERSION }));
  } catch {
    /* Storage unavailable or full; the session still works, it just will not
       be remembered. Not worth interrupting the player over. */
  }
}

export function clearSave(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* Nothing we can do, and nothing the player needs to hear about. */
  }
}

/** Records a result, returning whether either record was beaten. */
export function recordResult(
  save: SaveData,
  trackId: string,
  raceTime: number,
  bestLap: number,
  difficulty: string,
  speedClass = 'reclaim',
): { race: boolean; lap: boolean } {
  const existing = save.bests[trackId] ?? { race: Infinity, lap: Infinity, difficulty, speedClass };
  const beatRace = Number.isFinite(raceTime) && raceTime > 0 && raceTime < existing.race;
  const beatLap = Number.isFinite(bestLap) && bestLap > 0 && bestLap < existing.lap;
  save.bests[trackId] = {
    race: beatRace ? raceTime : existing.race,
    lap: beatLap ? bestLap : existing.lap,
    difficulty: beatRace ? difficulty : existing.difficulty,
    speedClass: beatRace ? speedClass : (existing.speedClass ?? 'reclaim'),
  };
  return { race: beatRace, lap: beatLap };
}

/** Records a championship result if it beats what is already stored. */
export function recordCircuit(
  save: SaveData,
  difficulty: string,
  speedClass: string,
  result: CircuitRecord,
): boolean {
  const key = `${difficulty}:${speedClass}`;
  const existing = save.circuits[key];
  // Better place wins; on a tie, more points; on a tie again, a quicker total.
  const better =
    !existing ||
    result.place < existing.place ||
    (result.place === existing.place && result.points > existing.points) ||
    (result.place === existing.place && result.points === existing.points && result.totalTime < existing.totalTime);
  if (better) save.circuits[key] = result;
  return better;
}

/** Exported for tests, which need to exercise migration without localStorage. */
export const __internal = { migrate };
