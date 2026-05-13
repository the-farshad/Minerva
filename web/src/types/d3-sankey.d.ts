declare module 'd3-sankey' {
  interface SankeyNode<N = unknown, L = unknown> {
    index?: number;
    x0?: number;
    x1?: number;
    y0?: number;
    y1?: number;
    value?: number;
    depth?: number;
    height?: number;
    sourceLinks?: SankeyLink<N, L>[];
    targetLinks?: SankeyLink<N, L>[];
    [k: string]: unknown;
  }
  interface SankeyLink<N = unknown, L = unknown> {
    source: number | string | SankeyNode<N, L>;
    target: number | string | SankeyNode<N, L>;
    value: number;
    width?: number;
    y0?: number;
    y1?: number;
    index?: number;
    [k: string]: unknown;
  }
  interface SankeyGraph<N = unknown, L = unknown> {
    nodes: (SankeyNode<N, L> & N)[];
    links: (SankeyLink<N, L> & L)[];
  }
  interface SankeyLayout<N = unknown, L = unknown> {
    (graph: { nodes: N[]; links: L[] }): SankeyGraph<N, L>;
    nodeWidth(): number;
    nodeWidth(width: number): SankeyLayout<N, L>;
    nodePadding(): number;
    nodePadding(padding: number): SankeyLayout<N, L>;
    extent(): [[number, number], [number, number]];
    extent(extent: [[number, number], [number, number]]): SankeyLayout<N, L>;
    iterations(): number;
    iterations(n: number): SankeyLayout<N, L>;
    nodeId(): (node: N) => string | number;
    nodeId(fn: (node: N) => string | number): SankeyLayout<N, L>;
    nodeAlign(): (node: N, n: number) => number;
    nodeAlign(fn: (node: N, n: number) => number): SankeyLayout<N, L>;
  }
  export function sankey<N = unknown, L = unknown>(): SankeyLayout<N, L>;
  export function sankeyCenter<N>(node: N, n: number): number;
  export function sankeyJustify<N>(node: N, n: number): number;
  export function sankeyLeft<N>(node: N, n: number): number;
  export function sankeyRight<N>(node: N, n: number): number;
  export function sankeyLinkHorizontal(): (link: SankeyLink) => string;
}
