// eslint.config.mjs

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // ① Start with ESLint's recommended rules (catches real bugs)
  eslint.configs.recommended,

  // ② Layer on TypeScript-specific rules
  //    "recommended" is the sweet spot — catches type errors
  //    without being so strict it's annoying on an existing codebase
  ...tseslint.configs.recommended,

  // ③ Tell ESLint which files to ignore
  {
    ignores: ["out/", "dist/", "node_modules/", "renderer/"],
  },

  // ④ Project-specific tweaks
  {
    rules: {
      // Allow unused vars prefixed with _ (common pattern for
      // intentionally unused params like _event in Electron handlers)
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // Allow `require()` — Electron main process often needs it
      "@typescript-eslint/no-require-imports": "off",
    },
  }
);
