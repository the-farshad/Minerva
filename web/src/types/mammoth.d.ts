declare module 'mammoth/mammoth.browser' {
  interface ConvertResult {
    value: string;
    messages: Array<{ type: string; message: string }>;
  }
  interface ConvertOptions {
    arrayBuffer: ArrayBuffer;
  }
  const mammoth: {
    convertToHtml(options: ConvertOptions): Promise<ConvertResult>;
    convertToMarkdown(options: ConvertOptions): Promise<ConvertResult>;
  };
  export default mammoth;
}
