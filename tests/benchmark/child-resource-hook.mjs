import fs from "node:fs";

const metricsPath = process.env.XHS_BENCHMARK_METRICS_PATH;
const started = process.hrtime.bigint();

if (metricsPath) {
  process.once("exit", (exitCode) => {
    const usage = process.resourceUsage();
    const payload = {
      exitCode,
      durationMs: Number(process.hrtime.bigint() - started) / 1e6,
      maxRssKilobytes: usage.maxRSS,
      userCpuMicroseconds: usage.userCPUTime,
      systemCpuMicroseconds: usage.systemCPUTime,
      fsReadOperations: usage.fsRead,
      fsWriteOperations: usage.fsWrite,
    };
    try {
      fs.writeFileSync(metricsPath, `${JSON.stringify(payload)}\n`, { encoding: "utf8", flag: "wx" });
    } catch {
      // The benchmark parent treats a missing metrics file as a failed measurement.
    }
  });
}
