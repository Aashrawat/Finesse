import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, "");
  const firebaseHost = env.VITE_FIREBASE_AUTH_DOMAIN || env.FIREBASE_AUTH_DOMAIN || "finesse-56a48.firebaseapp.com";
  const firebaseProxy = { target: `https://${firebaseHost}`, changeOrigin: true, secure: true };

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    server: {
      port: Number(process.env.PORT) || 5173,
      proxy: {
        "/api": process.env.API_TARGET || env.API_TARGET || "http://127.0.0.1:8000",
        "/__/auth": firebaseProxy,
        "/__/firebase": firebaseProxy,
      },
    },
  };
});
