// app.json plus the build's version (scripts/build-version.cjs): every build of a later commit installs over an earlier
// one and keeps the phone's data.
const { buildNumber, withBuildVersion } = require("./scripts/build-version.cjs");

module.exports = ({ config }) => withBuildVersion(config, buildNumber(__dirname));
