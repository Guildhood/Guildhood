/**
 * Neighborhood layouts. A layout is pure data shared by the authoritative server (collisions,
 * spawns, road surface) and the client (rendering), so both always agree on the world.
 *
 * Coordinates: meters on the ground plane (x, z); +y is up. Heading 0 faces +z.
 */

export interface Rect {
  /** Center. */
  x: number;
  z: number;
  /** Full size along x (w) and z (d). */
  w: number;
  d: number;
}

export interface Building extends Rect {
  h: number;
  wall: number;
  roof: number;
  kind: 'house' | 'shop' | 'hall';
}

export interface Circle {
  x: number;
  z: number;
  r: number;
}

export interface Tree extends Circle {
  h: number;
}

export interface SpawnPoint {
  x: number;
  z: number;
  heading: number;
}

export interface WorldMap {
  key: string;
  /** Square world: x and z range over [-halfSize, halfSize]. Edges are solid fences. */
  halfSize: number;
  roads: Rect[];
  /** Grass areas that are visually distinct (parks); purely cosmetic. */
  parks: Rect[];
  buildings: Building[];
  trees: Tree[];
  /** Other round solid props (fountain, planters). */
  props: Circle[];
  spawns: SpawnPoint[];
}

// -----------------------------------------------------------------------------------------------
// Copperleaf Commons (map key copperleaf_v1): a 200 m square with a ring road, two cross streets,
// four inner blocks (one a park with a fountain), and houses around the outside.
// -----------------------------------------------------------------------------------------------

const ROAD_W = 12;
const RING = 70; // ring road centerline offset from the middle
const HALF = 100;

const HOUSE_WALLS = [0xe8d7c0, 0xc9dbe0, 0xe6c9b8, 0xd5e0c4, 0xf0e2b6, 0xd8cbe3];
const HOUSE_ROOFS = [0x8a4b3a, 0x4f5d73, 0x6b4f3a, 0x5c6b4a, 0x7a3f4f, 0x3f5f66];

function buildCopperleaf(): WorldMap {
  const roads: Rect[] = [
    { x: 0, z: -RING, w: 2 * RING + ROAD_W, d: ROAD_W },
    { x: 0, z: RING, w: 2 * RING + ROAD_W, d: ROAD_W },
    { x: -RING, z: 0, w: ROAD_W, d: 2 * RING + ROAD_W },
    { x: RING, z: 0, w: ROAD_W, d: 2 * RING + ROAD_W },
    { x: 0, z: 0, w: ROAD_W, d: 2 * RING - ROAD_W },
    { x: 0, z: 0, w: 2 * RING - ROAD_W, d: ROAD_W },
  ];

  const buildings: Building[] = [];
  let n = 0;
  const house = (x: number, z: number, w: number, d: number, kind: Building['kind'] = 'house'): void => {
    buildings.push({
      x,
      z,
      w,
      d,
      h: kind === 'hall' ? 10 : 6 + (n % 3),
      wall: HOUSE_WALLS[n % HOUSE_WALLS.length]!,
      roof: HOUSE_ROOFS[(n * 5) % HOUSE_ROOFS.length]!,
      kind,
    });
    n++;
  };

  // Inner blocks span 6..64 on each axis. NE block (x>0, z<0) is the park ("the Commons").
  const inner = [17, 53];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      if (sx === 1 && sz === -1) continue; // park
      if (sx === -1 && sz === 1) {
        // SW block: a larger hall plus two houses.
        house(-35, 22, 22, 14, 'hall');
        house(-17, 53, 12, 10);
        house(-53, 53, 12, 10);
        continue;
      }
      for (const ix of inner) for (const iz of inner) house(sx * ix, sz * iz, 12, 10);
    }
  }

  // Outer strip between the ring road (edge at 76) and the fence (100): houses facing inward.
  for (const along of [-48, -16, 16, 48]) {
    house(along, -89, 12, 10);
    house(along, 89, 12, 10);
    house(-89, along, 10, 12);
    house(89, along, 10, 12);
  }
  // Corner shops.
  house(-88, -88, 14, 14, 'shop');
  house(88, 88, 14, 14, 'shop');

  const parks: Rect[] = [{ x: 35, z: -35, w: 58, d: 58 }];
  const props: Circle[] = [{ x: 35, z: -35, r: 4.5 }]; // fountain

  const trees: Tree[] = [];
  // Park trees in a ring around the fountain.
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    trees.push({ x: 35 + Math.cos(a) * 18, z: -35 + Math.sin(a) * 18, r: 0.7, h: 6 + (i % 3) });
  }
  // Street trees on the verges of the cross streets.
  for (const t of [-52, -30, 30, 52]) {
    trees.push({ x: t, z: 8.5, r: 0.6, h: 5 }, { x: t, z: -8.5, r: 0.6, h: 5 });
    trees.push({ x: 8.5, z: t, r: 0.6, h: 5 }, { x: -8.5, z: t, r: 0.6, h: 5 });
  }

  // Spawns on the ring road, driving clockwise (as seen from above with +z down the screen).
  const spawns: SpawnPoint[] = [];
  for (const along of [-40, -10, 20, 50]) {
    spawns.push({ x: along, z: -RING + 3, heading: Math.PI / 2 }); // north road heading +x
    spawns.push({ x: RING - 3, z: along, heading: 0 }); // east road heading +z
    spawns.push({ x: -along, z: RING - 3, heading: -Math.PI / 2 }); // south road heading -x
    spawns.push({ x: -RING + 3, z: -along, heading: Math.PI }); // west road heading -z
  }

  return { key: 'copperleaf_v1', halfSize: HALF, roads, parks, buildings, trees, props, spawns };
}

export const WORLDS: Readonly<Record<string, WorldMap>> = {
  copperleaf_v1: buildCopperleaf(),
};

export function worldByKey(key: string): WorldMap | undefined {
  return WORLDS[key];
}

export function pointInRect(px: number, pz: number, r: Rect, margin = 0): boolean {
  return Math.abs(px - r.x) <= r.w / 2 + margin && Math.abs(pz - r.z) <= r.d / 2 + margin;
}

export function isOnRoad(world: WorldMap, x: number, z: number): boolean {
  for (const r of world.roads) if (pointInRect(x, z, r)) return true;
  return false;
}
