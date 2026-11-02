import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import jsxA11y from "eslint-plugin-jsx-a11y";
import prettier from "eslint-config-prettier/flat";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // eslint-config-next registers the jsx-a11y plugin with a few rules;
    // enable the full recommended rule set on top of it.
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    // The admin client bypasses RLS. Only trusted server code may import it.
    files: ["**/*.{ts,tsx,mts,mjs}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/supabase/admin", "**/supabase/admin"],
              message:
                "The admin Supabase client bypasses RLS. Import it only from demo cleanup, the demo route handlers, Netlify functions, or scripts (see eslint.config.mjs).",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "src/lib/supabase/admin*.{ts,tsx}",
      "src/features/demo/cleanup/**",
      "src/lib/cleanup/**",
      "src/app/api/v1/demo/**",
      "netlify/functions/**",
      "scripts/**",
    ],
    rules: { "no-restricted-imports": "off" },
  },
  {
    // Free text is always rendered as text (PRD 9.3). React escapes it; dangerouslySetInnerHTML would turn
    // customer-controlled strings into markup, so it is banned everywhere (there is no exception list).
    files: ["**/*.{ts,tsx,mts,mjs,js,jsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: "Do not use dangerouslySetInnerHTML: render free text as text (PRD 9.3).",
        },
        {
          selector:
            "Property[key.name='dangerouslySetInnerHTML'], Property[key.value='dangerouslySetInnerHTML']",
          message: "Do not pass dangerouslySetInnerHTML: render free text as text (PRD 9.3).",
        },
      ],
    },
  },
  prettier,
  globalIgnores([".next/**", "out/**", "build/**", "coverage/**", "next-env.d.ts"]),
]);

export default eslintConfig;
