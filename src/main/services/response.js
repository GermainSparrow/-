const { toPublicError } = require("./app-error");

function ok(data = null) {
  return {
    ok: true,
    data,
    error: null
  };
}

function fail(error) {
  return {
    ok: false,
    data: null,
    error: toPublicError(error)
  };
}

async function runSafely(task) {
  try {
    return ok(await task());
  } catch (error) {
    return fail(error);
  }
}

module.exports = {
  ok,
  fail,
  runSafely
};
