import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import convexPlugin from "@convex-dev/eslint-plugin";

export default defineConfig([
  {
    // Global ignore list for generated output and tool config files
    // that we do not want ESLint to analyze.
    ignores: [
      "dist",
      "eslint.config.js",
      "convex/_generated",
      "postcss.config.js",
      "tailwind.config.js",
      "vite.config.ts",
      ".deepsec/**",
      ".claude/worktrees/**",
      ".codex-worktrees/**",
    ],
  },
  {
    // Main app/frontend TypeScript config.
    // This covers src/ and general TS files, but intentionally excludes
    // Convex server code so it can use its own tsconfig and rule boundary.
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    files: ["**/*.{ts,tsx}"],
    ignores: ["convex/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        project: ["./tsconfig.node.json", "./tsconfig.app.json"],
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      // These overrides keep the current codebase lintable while still
      // enforcing the most valuable safety checks. We can tighten them later.

      // Keep unused variables visible without blocking commits, and allow `_`
      // for intentionally ignored parameters and placeholders.
      "@typescript-eslint/no-unused-vars": ["warn", { varsIgnorePattern: "^_", argsIgnorePattern: "^_" }],

      // Still require intent when bypassing TypeScript with ts-comment directives.
      "@typescript-eslint/ban-ts-comment": "error",

      // The current app code still uses some explicit any boundaries.
      "@typescript-eslint/no-explicit-any": "off",

      // These "unsafe" rules are valuable, but too noisy for the current
      // migration state. Leave them off until we can clean them incrementally.
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",

      // Some handlers intentionally remain async for API consistency.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    // Dedicated config for Convex server code.
    // Convex uses a separate tsconfig and has different runtime conventions,
    // so we lint it in its own block instead of sharing the app parser setup.
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    files: ["convex/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        project: ["./convex/tsconfig.json", "./convex/eval/tsconfig.json"],
      },
    },
    rules: {
      // Mirror the app-side baseline so backend linting is active without
      // forcing a large cleanup before CI can be enabled.
      "@typescript-eslint/no-unused-vars": ["warn", { varsIgnorePattern: "^_", argsIgnorePattern: "^_" }],
      "@typescript-eslint/ban-ts-comment": "error",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/require-await": "off",
    },
  },
  // Convex's recommended ruleset adds framework-specific checks on top of the
  // generic TypeScript configs above. It complements them rather than replacing them.
  ...convexPlugin.configs.recommended,
  {
    // Temporary Convex-specific relaxations.
    // We keep these narrow so CI is useful today while we avoid a large
    // one-shot refactor of existing backend code.
    files: ["convex/**/*.ts"],
    rules: {
      "@convex-dev/explicit-table-ids": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
    },
  },
]);
