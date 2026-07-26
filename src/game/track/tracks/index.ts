import { Track } from '../buildTrack';
import type { TrackDefinition } from '../types';
import { EMBERFALL_QUARRY } from './emberfallQuarry';
import { GLASSHOUSE_VIGIL } from './glasshouseVigil';
import { OVERGROWN_INTERCHANGE } from './overgrownInterchange';
import { SALTFLAT_RELIQUARY } from './saltflatReliquary';

/** Courses in the order they are presented, easiest first. */
export const TRACK_DEFINITIONS: readonly TrackDefinition[] = [
  OVERGROWN_INTERCHANGE,
  SALTFLAT_RELIQUARY,
  GLASSHOUSE_VIGIL,
  EMBERFALL_QUARRY,
];

/**
 * Building a `Track` walks the whole spline and rebuilds the broadphase grid,
 * so instances are cached. They are immutable once built.
 */
const cache = new Map<string, Track>();

export function getTrack(id: string): Track {
  const cached = cache.get(id);
  if (cached) return cached;
  const definition = TRACK_DEFINITIONS.find((t) => t.id === id);
  if (!definition) throw new Error(`Unknown track: ${id}`);
  const track = new Track(definition);
  cache.set(id, track);
  return track;
}

export function getTrackDefinition(id: string): TrackDefinition {
  const definition = TRACK_DEFINITIONS.find((t) => t.id === id);
  if (!definition) throw new Error(`Unknown track: ${id}`);
  return definition;
}

export { EMBERFALL_QUARRY, GLASSHOUSE_VIGIL, OVERGROWN_INTERCHANGE, SALTFLAT_RELIQUARY };
