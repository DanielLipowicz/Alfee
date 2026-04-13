const fs = require("fs");
const path = require("path");
const winston = require("winston");

const { combine, timestamp, errors, json } = winston.format;

const DEFAULT_MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024;
const LEVELS = new Set(["debug", "info", "warn", "error"]);

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function normalizeLevel(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (LEVELS.has(normalized)) {
    return normalized;
  }
  return "info";
}

function stripUndefinedFields(payload) {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined)
  );
}

function serializeError(error) {
  if (!error) {
    return null;
  }
  if (error instanceof Error) {
    return stripUndefinedFields({
      name: error.name,
      message: error.message,
      code: error.code,
      stack: error.stack,
    });
  }
  if (typeof error === "object") {
    return stripUndefinedFields(error);
  }
  return { message: String(error) };
}

const LOG_DIRECTORY = process.env.LOG_DIR
  ? path.resolve(process.env.LOG_DIR)
  : path.join(process.cwd(), "data", "logs");
const ALL_LOG_FILE = path.join(LOG_DIRECTORY, "app.log");
const ERROR_LOG_FILE = path.join(LOG_DIRECTORY, "error.log");
const MAX_LOG_SIZE_BYTES = parsePositiveInteger(
  process.env.LOG_MAX_SIZE_BYTES,
  DEFAULT_MAX_LOG_SIZE_BYTES
);
const MIN_LOG_LEVEL = normalizeLevel(process.env.LOG_LEVEL || "info");
const MIRROR_TO_STDOUT =
  String(process.env.LOG_MIRROR_STDOUT || "true").toLowerCase() !== "false";

fs.mkdirSync(LOG_DIRECTORY, { recursive: true });

const logger = winston.createLogger({
  level: MIN_LOG_LEVEL,
  defaultMeta: {
    pid: process.pid,
  },
  format: combine(
    errors({ stack: true }),
    timestamp(),
    json()
  ),
  transports: [
    new winston.transports.File({
      filename: ALL_LOG_FILE,
      level: MIN_LOG_LEVEL,
      maxsize: MAX_LOG_SIZE_BYTES,
      maxFiles: 1,
      tailable: true,
    }),
    new winston.transports.File({
      filename: ERROR_LOG_FILE,
      level: "error",
      maxsize: MAX_LOG_SIZE_BYTES,
      maxFiles: 1,
      tailable: true,
    }),
  ],
});

if (MIRROR_TO_STDOUT) {
  logger.add(
    new winston.transports.Console({
      level: MIN_LOG_LEVEL,
      stderrLevels: ["error"],
    })
  );
}

logger.on("error", (error) => {
  try {
    process.stderr.write(
      `[logger] Winston transport error: ${JSON.stringify(
        serializeError(error)
      )}\n`
    );
  } catch (_error) {
    // Intentionally ignored to avoid crashing due to logging failures.
  }
});

function write(level, message, details = {}) {
  logger.log({
    level,
    message: String(message),
    ...stripUndefinedFields(details),
  });
}

module.exports = {
  debug(message, details) {
    write("debug", message, details);
  },
  info(message, details) {
    write("info", message, details);
  },
  warn(message, details) {
    write("warn", message, details);
  },
  error(message, details) {
    write("error", message, details);
  },
  serializeError,
  constants: {
    LOG_DIRECTORY,
    ALL_LOG_FILE,
    ERROR_LOG_FILE,
    MAX_LOG_SIZE_BYTES,
  },
};
