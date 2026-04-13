const { randomUUID } = require("crypto");
const logger = require("../utils/logger");

function determineLevelFromStatusCode(statusCode) {
  if (statusCode >= 500) {
    return "error";
  }
  if (statusCode >= 400) {
    return "warn";
  }
  return "info";
}

function requestLogger(req, res, next) {
  const startTimestamp = process.hrtime.bigint();
  req.requestId = req.requestId || randomUUID();
  res.setHeader("X-Request-Id", req.requestId);

  res.on("finish", () => {
    const durationNs = process.hrtime.bigint() - startTimestamp;
    const durationMs = Number(durationNs) / 1e6;
    const statusCode = Number(res.statusCode) || 0;
    const level = determineLevelFromStatusCode(statusCode);
    const logPayload = {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      statusCode,
      durationMs: Number(durationMs.toFixed(2)),
      ip: req.ip,
      userAgent: req.get("user-agent"),
      userId: req.user?.id ? Number(req.user.id) : null,
      organizationId: req.session?.activeOrganizationId
        ? Number(req.session.activeOrganizationId)
        : null,
    };

    if (level === "error") {
      logger.error("HTTP request completed", logPayload);
      return;
    }
    if (level === "warn") {
      logger.warn("HTTP request completed", logPayload);
      return;
    }
    logger.info("HTTP request completed", logPayload);
  });

  next();
}

module.exports = {
  requestLogger,
};
