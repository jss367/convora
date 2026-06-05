import globals from "globals";
import pluginJs from "@eslint/js";
import pluginReactConfig from "eslint-plugin-react/configs/recommended.js";
import { fixupConfigRules } from "@eslint/compat";


export default [
  { ignores: ["dist/**", "node_modules/**"] },
  {files: ["**/*.{js,mjs,cjs,jsx}"]},
  { languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } } },
  {languageOptions: { globals: {...globals.browser, ...globals.node} }},
  { settings: { react: { version: "detect" } } },
  pluginJs.configs.recommended,
  ...fixupConfigRules(pluginReactConfig),
];
