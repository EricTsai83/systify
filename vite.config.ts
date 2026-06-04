import { defineConfig } from "vite";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { validateBuildEnv } from "./env";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  Object.assign(process.env, loadEnv(mode, process.cwd(), ""));
  validateBuildEnv();

  return {
    build: {
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes("node_modules")) {
              return;
            }

            const normalizedId = id.split(path.sep).join("/");

            if (
              normalizedId.includes("/node_modules/react/") ||
              normalizedId.includes("/node_modules/react-dom/") ||
              normalizedId.includes("/node_modules/scheduler/")
            ) {
              return "vendor-react";
            }

            if (
              normalizedId.includes("/node_modules/react-router") ||
              normalizedId.includes("/node_modules/@remix-run/")
            ) {
              return "vendor-router";
            }

            if (normalizedId.includes("/node_modules/convex/")) {
              return "vendor-convex";
            }

            if (normalizedId.includes("/node_modules/@workos-inc/")) {
              return "vendor-auth";
            }

            if (
              normalizedId.includes("/node_modules/streamdown/") ||
              normalizedId.includes("/node_modules/@streamdown/") ||
              normalizedId.includes("/node_modules/mermaid/") ||
              normalizedId.includes("/node_modules/shiki/") ||
              normalizedId.includes("/node_modules/katex/")
            ) {
              return "vendor-markdown";
            }

            if (
              normalizedId.includes("/node_modules/@base-ui/") ||
              normalizedId.includes("/node_modules/@radix-ui/") ||
              normalizedId.includes("/node_modules/radix-ui/") ||
              normalizedId.includes("/node_modules/cmdk/") ||
              normalizedId.includes("/node_modules/embla-carousel") ||
              normalizedId.includes("/node_modules/lucide-react/") ||
              normalizedId.includes("/node_modules/motion/") ||
              normalizedId.includes("/node_modules/sonner/") ||
              normalizedId.includes("/node_modules/vaul/")
            ) {
              return "vendor-ui";
            }
          },
        },
      },
    },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  };
});
