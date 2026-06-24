//cytoscape-cola ships no types, declare the minimal shape we use.
declare module "cytoscape-cola" {
  import type { Ext } from "cytoscape";
  const ext: Ext;
  export default ext;
}

//app version injected at build time by vite's define (see vite.config.ts)
declare const __APP_VERSION__: string;
