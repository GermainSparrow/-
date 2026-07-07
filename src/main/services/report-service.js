const fs = require("node:fs/promises");
const path = require("node:path");
const { summarizeEntities } = require("./entity-service");

function publicOutputs(outputs) {
  return Object.fromEntries(Object.entries(outputs).map(([key, value]) => {
    if (typeof value === "string") {
      return [key, path.basename(value)];
    }
    return [key, value];
  }));
}

function createReport({ sourceLabel, mode, entities, warnings, outputs }) {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    sourceLabel,
    mode,
    entitySummary: summarizeEntities(entities),
    warnings,
    outputs: publicOutputs(outputs)
  };
}

async function writeReport(outputPath, report) {
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
}

module.exports = {
  createReport,
  writeReport
};
