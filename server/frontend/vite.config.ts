import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

//dev: `npm run dev` serves on :5173 and proxies /api to the running FastAPI server.
//build: `npm run build` -> dist/, which the Docker image copies in for FastAPI to serve.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://localhost:8791" },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
