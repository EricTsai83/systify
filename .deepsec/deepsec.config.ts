import { defineConfig } from "deepsec/config";

export default defineConfig({
  defaultAgent: "codex", // claude
  projects: [
    { id: "systify", root: ".." },
    // <deepsec:projects-insert-above>
  ],
});
