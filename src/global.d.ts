/**
 * Global type declarations for veditor
 */

declare const chrome: any;
declare const browser: any;

declare module '*?url' {
  const url: string;
  export default url;
}

declare module 'pdfjs-dist/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: any;
}

