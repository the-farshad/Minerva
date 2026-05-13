declare module 'd3-force-3d' {
  type Accessor<T> = T | ((node: unknown, i?: number, nodes?: unknown[]) => T);

  interface CollideForce {
    radius(r: Accessor<number>): CollideForce;
    strength(s: number): CollideForce;
    iterations(i: number): CollideForce;
  }
  interface PositionalForce {
    x?(x: Accessor<number>): PositionalForce;
    y?(y: Accessor<number>): PositionalForce;
    strength(s: Accessor<number>): PositionalForce;
  }

  export function forceCollide(radius?: Accessor<number>): CollideForce;
  export function forceX(x?: Accessor<number>): PositionalForce;
  export function forceY(y?: Accessor<number>): PositionalForce;
}
