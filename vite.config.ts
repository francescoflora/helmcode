import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

const editorVendor = /node_modules[\\/](?:@codemirror[\\/](?:view|state|language|language-data|autocomplete|commands|search|lint)|@lezer[\\/](?:common|highlight)|codemirror[\\/]|style-mod[\\/]|w3c-keyname[\\/]|crelt[\\/])/;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "chrome105",
    sourcemap: false,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "react", test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/, priority: 3 },
            { name: "editor", test: (id) => editorVendor.test(id), priority: 2 },
          ],
        },
      },
    },
  },
});
