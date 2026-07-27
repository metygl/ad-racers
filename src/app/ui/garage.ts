import { CREW_SILHOUETTES } from '../../render/scene/VehicleModel';
import type { RacerProfile } from '../../game/racers';
import type { TrackDefinition } from '../../game/track/types';
import { previewMainPath } from '../../game/track/buildTrack';

/**
 * The garage: crew and course presentation for the setup screen.
 *
 * The review's judgement on the old setup was that it is "a data form rather
 * than premium game presentation" — four text-heavy course cards, six crew
 * cards, no image of anything, and a player picking a machine with no idea what
 * it looks like. That is a real problem beyond aesthetics: crew identity in
 * this game is carried by *silhouette*, and a selection screen that never shows
 * one is asking the player to choose blind.
 *
 * Both drawings here are made from the same data the 3D scene uses — the crew
 * build table and the course's own centreline — so a card can never disagree
 * with the thing it is advertising. They are SVG rather than a second WebGL
 * context: a live 3D preview would mean a second renderer, a second scene and a
 * second frame budget on a screen that is not a race, and would still tell the
 * player less than a clean profile does.
 */

/**
 * A crew's skiff in profile, drawn from its build.
 *
 * Deliberately a *silhouette* with the crew's colours on the masses that carry
 * them in-race: hull, fin, and the outrigger pod. If a player can recognise the
 * shape here, they can recognise it at forty metres in fog, which is the whole
 * design contract for the six crews.
 */
export function crewSilhouette(profile: RacerProfile): SVGSVGElement {
  const build = CREW_SILHOUETTES[profile.id] ?? CREW_SILHOUETTES.thornline;
  if (!build) throw new Error(`no silhouette for ${profile.id}`);

  const hex = (value: number): string => `#${value.toString(16).padStart(6, '0')}`;
  const body = hex(profile.colors.body);
  const trim = hex(profile.colors.trim);
  const glow = hex(profile.colors.glow);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 120 54');
  svg.setAttribute('class', 'silhouette');
  svg.setAttribute('role', 'img');
  svg.setAttribute(
    'aria-label',
    `${profile.skiff}: ${build.blades === 2 ? 'twin' : 'single'} fin, ` +
      `${build.struts.length} hover struts, ${build.nose > 1.2 ? 'long' : build.nose < 0.8 ? 'blunt' : 'swept'} nose`,
  );

  const add = (tag: string, attrs: Record<string, string>): void => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    svg.append(node);
  };

  // Baseline the struts stand on.
  const ground = 44;
  const hullTop = ground - 12 * build.shoulder;
  const noseTip = 26 - 12 * build.nose;

  // Hull: nose wedge into a slab, in the crew's body colour.
  add('path', {
    d:
      `M ${noseTip} ${hullTop + 6} L 34 ${hullTop} L 96 ${hullTop} ` +
      `L 100 ${hullTop + 5} L 98 ${ground - 2} L 36 ${ground - 2} Z`,
    fill: body,
  });

  // Fin, raked back by the build's own sweep.
  const finBase = 90;
  const finTop = hullTop - 13 * build.height;
  for (let blade = 0; blade < build.blades; blade++) {
    const offset = build.blades === 1 ? 0 : blade === 0 ? -2.5 : 2.5;
    add('path', {
      d: `M ${finBase + offset} ${hullTop} L ${finBase + offset + 9 * build.sweep} ${finTop} ` +
        `L ${finBase + offset + 5 + 9 * build.sweep} ${finTop + 2} L ${finBase + offset + 9} ${hullTop} Z`,
      fill: trim,
    });
  }

  // Roll hoop over the pilot.
  if (build.hoop > 0) {
    add('path', {
      d: `M 62 ${hullTop - 4} L 62 ${hullTop - 4 - 11 * build.hoop} L 74 ${hullTop - 4 - 11 * build.hoop} L 74 ${hullTop - 4}`,
      fill: 'none',
      stroke: trim,
      'stroke-width': '2',
    });
  }

  // Hover struts, at the build's own stations.
  for (const along of build.struts) {
    const x = 66 + along * 30;
    add('rect', { x: String(x - 1.4), y: String(ground - 3), width: '2.8', height: '6', fill: '#1b1f26' });
    add('ellipse', { cx: String(x), cy: String(ground + 3), rx: '5', ry: '1.8', fill: '#1b1f26' });
  }

  // Outrigger spar and pod, drawn low and forward so it reads as offset.
  add('rect', { x: '52', y: String(ground - 6), width: '22', height: '2', fill: '#1b1f26' });
  add('ellipse', { cx: '52', cy: String(ground - 5), rx: '7', ry: '4.5', fill: body });
  add('circle', { cx: '52', cy: String(ground - 9), r: '2.6', fill: trim });

  // Counterweighted boom, folded back at rest.
  add('path', {
    d: `M 52 ${ground - 7} L 38 ${ground - 12}`,
    stroke: trim,
    'stroke-width': '1.6',
    fill: 'none',
  });
  add('circle', { cx: '38', cy: String(ground - 12), r: String(3 + build.counterweight * 4), fill: trim });

  // Thrust glow at the tail: the one place the glow colour appears.
  add('ellipse', { cx: '101', cy: String(hullTop + 8), rx: '4', ry: '3.5', fill: glow, opacity: '0.85' });

  return svg;
}

/**
 * A course as a diorama: its actual centreline, its shortcut, and its start.
 *
 * Drawn from `previewMainPath`, so it is the same spline the race is run on
 * rather than an illustration that can drift out of date. A player choosing a
 * course can see whether it is fast and open or tight and technical before
 * committing three laps to it, which the text alone never conveyed.
 */
export function courseDiorama(track: TrackDefinition): SVGSVGElement {
  const main = previewMainPath(track.points);
  const points = main.samples.map((sample) => sample.pos);

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  }
  const pad = 10;
  const width = maxX - minX || 1;
  const height = maxZ - minZ || 1;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `${minX - pad} ${minZ - pad} ${width + pad * 2} ${height + pad * 2}`);
  svg.setAttribute('class', 'diorama');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${track.name} course layout`);

  const path = (list: readonly { x: number; z: number }[], close: boolean): string =>
    list.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.z.toFixed(1)}`).join(' ') + (close ? ' Z' : '');

  const add = (tag: string, attrs: Record<string, string>): void => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    svg.append(node);
  };

  const theme = track.theme;
  const hex = (value: number): string => `#${value.toString(16).padStart(6, '0')}`;

  // The road as a wide stroke, in the course's own surface colour, so the four
  // dioramas are immediately distinguishable from each other.
  add('path', { d: path(points, true), fill: 'none', stroke: hex(theme.shoulderColor), 'stroke-width': '26', 'stroke-linejoin': 'round' });
  add('path', { d: path(points, true), fill: 'none', stroke: hex(theme.roadColor), 'stroke-width': '20', 'stroke-linejoin': 'round' });

  // Shortcuts, dashed in the kerb accent: visibly an alternative, not the road.
  for (const branch of track.branches) {
    add('path', {
      d: path(branch.points, false),
      fill: 'none',
      stroke: hex(theme.kerbColor ?? 0xffffff),
      'stroke-width': '9',
      'stroke-dasharray': '18 12',
      'stroke-linecap': 'round',
      opacity: '0.9',
    });
  }

  // The start line.
  const start = points[0];
  if (start) add('circle', { cx: start.x.toFixed(1), cy: start.z.toFixed(1), r: '14', fill: hex(theme.kerbColor ?? 0xffffff) });

  return svg;
}
