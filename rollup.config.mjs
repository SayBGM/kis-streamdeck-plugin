import resolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

export default {
  input: "src/plugin.ts",
  output: {
    file: "bin/plugin.js",
    format: "esm",
    sourcemap: true,
  },
  external: ["@elgato/streamdeck", "ws"],
  plugins: [
    resolve({
      preferBuiltins: true,
    }),
    typescript(),
  ],
};
