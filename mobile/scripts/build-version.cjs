// The Android version of a build, from the code itself: versionCode = 100 + the number of commits in the history, so a
// later commit always gets a higher number than an earlier one, whoever builds it (CI or a local release build) and
// whatever order runs are started in. A newer APK then installs over the installed one and keeps its data; Android
// refuses a lower version. The name people see is 1.1.<commits>.
const { execSync } = require("node:child_process");

function git(args, cwd) {
  return execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
}

/** The build number, or 0 when there is no git history (then app.json's own version is kept). */
function buildNumber(cwd, env = process.env) {
  if (env.MOTARD_BUILD_NUMBER) {
    const n = Number(env.MOTARD_BUILD_NUMBER);
    if (!Number.isInteger(n) || n <= 0)
      throw new Error("MOTARD_BUILD_NUMBER must be a positive integer");
    return n;
  }
  let count;
  try {
    // A shallow clone counts only the commits it fetched: the number would go backwards. A CI build must not ship
    // that; elsewhere (development) the build keeps app.json's version.
    if (git("rev-parse --is-shallow-repository", cwd) === "true") {
      if (env.CI) {
        throw new Error(
          "shallow git history: fetch the full history (fetch-depth: 0) to number the build",
        );
      }
      return 0;
    }
    count = Number(git("rev-list --count HEAD", cwd));
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("shallow")) throw e;
    return 0;
  }
  return Number.isInteger(count) && count > 0 ? count : 0;
}

/** The Expo config with the build's version; unchanged for build number 0. */
function withBuildVersion(config, n) {
  if (!n) return config;
  return {
    ...config,
    version: `1.1.${n}`,
    android: { ...config.android, versionCode: 100 + n },
  };
}

module.exports = { buildNumber, withBuildVersion };
