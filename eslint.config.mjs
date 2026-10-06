import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".next/**", "node_modules/**", "out/**", "prisma/migrations/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-unused-vars": "off",
      "prefer-const": "warn",
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-require-imports": "warn",
    },
  },
);
