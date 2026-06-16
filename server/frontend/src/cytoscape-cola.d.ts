//cytoscape-cola ships no types, declare the minimal shape we use.
declare module "cytoscape-cola" {
  import type { Ext } from "cytoscape";
  const ext: Ext;
  export default ext;
}
