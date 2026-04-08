const test = require("node:test");
const assert = require("node:assert/strict");

const employeeRoutes = require("../../src/routes/employeeRoutes");
const { db } = require("../../src/database");

function getToggleHandler() {
  const layer = employeeRoutes.stack.find(
    (item) =>
      item.route &&
      item.route.path === "/tasks/:assignmentId/steps/:stepId/toggle" &&
      item.route.methods.post
  );

  if (!layer) {
    throw new Error("Nie znaleziono trasy toggle w employeeRoutes.");
  }

  return layer.route.stack[0].handle;
}

function createJsonRequest(params) {
  return {
    params,
    user: { id: 10 },
    get(headerName) {
      if (String(headerName || "").toLowerCase() === "accept") {
        return "application/json";
      }
      return "";
    },
  };
}

function createJsonResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
    render() {
      throw new Error("Nie oczekiwano render przy zapytaniu JSON.");
    },
    redirect() {
      throw new Error("Nie oczekiwano redirect przy zapytaniu JSON.");
    },
  };
}

test("toggle przełącza krok z completed='1' na 0", async () => {
  const handler = getToggleHandler();
  const originalGet = db.get;
  const originalRun = db.run;
  const runCalls = [];

  db.get = async (sql) => {
    if (sql.includes("FROM assignment_steps s") && sql.includes("s.completed")) {
      return { id: 321, completed: "1" };
    }

    if (sql.includes("FROM assignments a") && sql.includes("task_title")) {
      return {
        id: 77,
        status: "completed",
        assigned_by: 999,
        task_title: "Task test",
        employee_name: "Emp test",
      };
    }

    if (sql.includes("COUNT(*) AS total")) {
      return { total: 1, done: 0, completed_at: null };
    }

    return null;
  };

  db.run = async (sql, params = []) => {
    runCalls.push({ sql, params });
    return { lastID: 1, changes: 1 };
  };

  const req = createJsonRequest({ assignmentId: "77", stepId: "321" });
  const res = createJsonResponse();

  try {
    await handler(req, res, (error) => {
      if (error) {
        throw error;
      }
    });
  } finally {
    db.get = originalGet;
    db.run = originalRun;
  }

  const updateCall = runCalls.find((call) =>
    call.sql.includes("UPDATE assignment_steps")
  );

  assert.ok(updateCall, "Brak wywołania UPDATE assignment_steps.");
  assert.deepEqual(updateCall.params, [0, 0, 321]);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload?.ok, true);
  assert.equal(res.payload?.step?.completed, 0);
});
