// Makes `require("react-native")` (used inside @testing-library/react-native) resolve to the Node stub too.
import Module from "node:module";
import path from "node:path";

const stub = path.resolve(__dirname, "helpers/reactNativeStub.cjs");
type Resolver = (request: string, ...rest: unknown[]) => string;
const internals = Module as unknown as { _resolveFilename: Resolver };
const original = internals._resolveFilename;
internals._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === "react-native") return stub;
  return original.call(this, request, ...rest);
};
