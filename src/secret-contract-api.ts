// OpenClaw discovers external-plugin secret contracts only at the package root
// or directly under dist/. Keep this public entry point at src/ root so tsc emits
// dist/secret-contract-api.js; the channel-local module remains the implementation
// owner used by the plugin itself.
export {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
} from "./channel/src/secret-contract.js";
