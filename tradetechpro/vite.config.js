import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:8787",
      "/invite": "http://localhost:8787",
      "/i": "http://localhost:8787",
      "/admin": "http://localhost:8787",
      "/w": "http://localhost:8787",
      "/ventas": "http://localhost:8787",
      "/demo": "http://localhost:8787",
      "/ejemplo": "http://localhost:8787",
      "/cierre": "http://localhost:8787",
      "/site": "http://localhost:8787",
      "/plantilla": "http://localhost:8787",
      "/plantillas": "http://localhost:8787",
      "/onboarding": "http://localhost:8787",
      "/equipo": "http://localhost:8787",
    },
  },
});
