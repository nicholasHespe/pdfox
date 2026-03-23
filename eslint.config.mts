import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  tseslint.configs.recommended,
  {
    ignores: ["out/", "dist/", "node_modules/", "renderer/"],
  },
  {
    // Type-aware rules — requires TypeScript project context
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      // Allow unused vars/args prefixed with _ (e.g. _event in Electron handlers)
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // Allow require() — Electron main process often needs it
      "@typescript-eslint/no-require-imports": "off",
      // Warn on assigning dynamically-typed (any) values
      "@typescript-eslint/no-unsafe-assignment": "warn",
    },
  },
]);
