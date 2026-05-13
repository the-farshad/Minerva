declare module 'd3-force-3d' {
  type Accessor<T> = T | ((node: unknown, i?: number, nodes?: unknown[]) => T);

  interface CollideForce {
    radius(r: Accessor<number>): CollideForce;
    strength(s: number): CollideForce;
    iterations(i: number): CollideForce;
  }
  interface YForce {
    y(y: Accessor<number>): YForce;
    strength(s: Accessor<number>): YForce;
  }

  export function forceCollide(radius?: Accessor<number>): CollideForce;
  export function forceY(y?: Accessor<number>): YForce;
}
