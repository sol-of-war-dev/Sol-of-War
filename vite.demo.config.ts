import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { defineConfig } from "vite";
import { walletLoginDiagnostics } from "./scripts/walletLoginDiagnostics.ts";

export default defineConfig(({ mode }) => ({
  publicDir: false,
  resolve: {
    tsconfigPaths: true,
    alias: { resources: path.resolve("resources") },
  },
  plugins: [
    tailwindcss(),
    ...(mode === "wallet-diagnostics" ? [walletLoginDiagnostics()] : []),
  ],
  define: {
    __ASSET_MANIFEST__: "{}",
    "import.meta.env.VITE_FRONTPOT": "true",
    "process.env.GAME_ENV": '"dev"',
    "process.env.API_DOMAIN": '""',
    "process.env.WEBSOCKET_URL": '""',
  },
  build: {
    outDir: "dist-demo",
    rollupOptions: { input: "demo.html" },
    sourcemap: false,
  },
  worker: { format: "es" },
}));
