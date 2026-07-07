class AppError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}

function toPublicError(error) {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: error?.message || "处理失败",
    details: null
  };
}

function assertCondition(condition, code, message, details = null) {
  if (!condition) {
    throw new AppError(code, message, details);
  }
}

module.exports = {
  AppError,
  assertCondition,
  toPublicError
};
