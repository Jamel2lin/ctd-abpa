import tseslint from "@typescript-eslint/eslint-plugin";
import parser from "@typescript-eslint/parser";

export default [{ ignores: ["**/dist/**", "node_modules/**", "outputs/**", "data/**", "test-results/**", "playwright-report/**", ".tasks/**", ".config/**"] }, {
  files: ["**/*.ts", "**/*.tsx"],
  languageOptions: { parser, parserOptions: { project: "./tsconfig.json" } },
  plugins: { "@typescript-eslint": tseslint },
  rules: { "@typescript-eslint/no-explicit-any": "off" }
}];
