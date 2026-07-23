/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  rootDir: "..",
  roots: ["<rootDir>/tests"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: { module: "commonjs" } }],
  },
};
