declare module 'funnel-graph-js-xl' {
  interface FunnelGraphOptions {
    container: string | HTMLElement;
    gradientDirection?: 'horizontal' | 'vertical';
    direction?: 'horizontal' | 'vertical';
    data: {
      labels: string[];
      subLabels?: string[];
      colors: string[] | string[][];
      values: number[] | number[][];
    };
    displayPercent?: boolean;
    width?: number;
    height?: number;
    subLabelValue?: 'percent' | 'raw';
  }

  export default class FunnelGraph {
    constructor(options: FunnelGraphOptions);
    draw(): void;
    update(): void;
    updateData(data: FunnelGraphOptions['data']): void;
    destroy?(): void;
  }
}
