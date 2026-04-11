const test = require("node:test");
const assert = require("node:assert/strict");

const adminRoutes = require("../../src/routes/adminRoutes");
const managerRoutes = require("../../src/routes/managerRoutes");
const { db } = require("../../src/database");

function getDeleteUserHandler() {
  const layer = adminRoutes.stack.find(
    (item) =>
      item.route &&
      item.route.path === "/users/:userId" &&
      item.route.methods.delete
  );

  if (!layer) {
    throw new Error("Nie znaleziono trasy usuwania uzytkownika w adminRoutes.");
  }

  return layer.route.stack[0].handle;
}

function getCreateEmployeeHandler() {
  const layer = managerRoutes.stack.find(
    (item) =>
      item.route &&
      item.route.path === "/employees" &&
      item.route.methods.post
  );

  if (!layer) {
    throw new Error("Nie znaleziono trasy tworzenia pracownika w managerRoutes.");
  }

  return layer.route.stack[0].handle;
}

function createRequest({ userId, adminId }) {
  return {
    params: { userId: String(userId) },
    user: { id: adminId, role: "admin" },
    session: {},
  };
}

function createResponse() {
  return {
    statusCode: 200,
    redirectedTo: null,
    rendered: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    render(view, payload) {
      this.rendered = { view, payload };
      return this;
    },
    redirect(path) {
      this.redirectedTo = path;
      return this;
    },
  };
}

test("delete user anonimizuje konto bez fizycznego usuwania rekordu users", async () => {
  const handler = getDeleteUserHandler();
  const originalGet = db.get;
  const originalRun = db.run;
  const runCalls = [];

  db.get = async (sql, params = []) => {
    if (sql.includes("SELECT id, name, role, deleted_at FROM users")) {
      return { id: Number(params[0]), name: "Jan Kowalski", role: "employee", deleted_at: null };
    }
    return null;
  };

  db.run = async (sql, params = []) => {
    runCalls.push({ sql, params });
    return { lastID: 1, changes: 1 };
  };

  const req = createRequest({ userId: 21, adminId: 1 });
  const res = createResponse();

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

  const updateCall = runCalls.find((call) => call.sql.includes("UPDATE users"));
  assert.ok(updateCall, "Brak anonimizacji konta (UPDATE users).");
  assert.equal(updateCall.params[2], 21);
  assert.match(updateCall.params[0], /^deleted-user-21-\d+@alfee\.invalid$/);
  assert.equal(updateCall.params[1], "Usuniete konto #21");
  assert.ok(
    runCalls.every((call) => !call.sql.includes("DELETE FROM users")),
    "Nie oczekiwano fizycznego usuwania z tabeli users."
  );
  assert.equal(res.redirectedTo, "/admin/organizations");
});

test("po usunieciu konta ten sam email moze byc ponownie dodany przez innego kierownika", async () => {
  const deleteHandler = getDeleteUserHandler();
  const createEmployeeHandler = getCreateEmployeeHandler();
  const originalGet = db.get;
  const originalRun = db.run;
  let nextUserId = 100;
  const users = [
    { id: 1, email: "admin@example.com", name: "Admin", role: "admin", deleted_at: null },
    { id: 21, email: "pracownik@example.com", name: "Stary Pracownik", role: "employee", deleted_at: null },
    { id: 30, email: "kierownik2@example.com", name: "Kierownik 2", role: "manager", deleted_at: null },
  ];
  const userOrganizations = [];

  db.get = async (sql, params = []) => {
    if (sql.includes("SELECT id, name, role, deleted_at FROM users WHERE id = ?")) {
      const userId = Number(params[0]);
      return users.find((user) => user.id === userId) || null;
    }

    if (sql.includes("SELECT COUNT(*) AS total FROM users WHERE role = 'admin'")) {
      const total = users.filter(
        (user) => user.role === "admin" && user.deleted_at == null
      ).length;
      return { total };
    }

    if (sql.includes("SELECT id FROM users WHERE lower(email) = lower(?)")) {
      const email = String(params[0] || "").toLowerCase();
      const existing = users.find(
        (user) => String(user.email || "").toLowerCase() === email
      );
      return existing ? { id: existing.id } : null;
    }

    return null;
  };

  db.run = async (sql, params = []) => {
    if (sql.includes("UPDATE users") && sql.includes("deleted_at = CURRENT_TIMESTAMP")) {
      const targetId = Number(params[2]);
      const target = users.find((user) => user.id === targetId);
      if (target) {
        target.email = params[0];
        target.name = params[1];
        target.role = "employee";
        target.deleted_at = "2026-04-11 10:00:00";
      }
      return { changes: target ? 1 : 0, lastID: targetId };
    }

    if (sql.includes("INSERT INTO users (google_id, email, name, auth_provider, password_hash, is_active, role)")) {
      const createdId = nextUserId;
      nextUserId += 1;
      users.push({
        id: createdId,
        email: params[1],
        name: params[2],
        role: "employee",
        deleted_at: null,
      });
      return { changes: 1, lastID: createdId };
    }

    if (sql.includes("INSERT OR IGNORE INTO user_organizations")) {
      userOrganizations.push({
        user_id: Number(params[0]),
        organization_id: Number(params[1]),
      });
      return { changes: 1, lastID: 1 };
    }

    return { changes: 1, lastID: 1 };
  };

  const adminReq = createRequest({ userId: 21, adminId: 1 });
  const adminRes = createResponse();

  const managerReq = {
    body: {
      email: "pracownik@example.com",
      name: "Nowy Pracownik",
      password: "SilneHaslo!1",
      passwordConfirm: "SilneHaslo!1",
      observerEmail: "",
    },
    activeOrganizationId: 7,
    session: {},
    user: { id: 30, role: "manager" },
  };
  const managerRes = createResponse();

  try {
    await deleteHandler(adminReq, adminRes, (error) => {
      if (error) {
        throw error;
      }
    });

    await createEmployeeHandler(managerReq, managerRes, (error) => {
      if (error) {
        throw error;
      }
    });
  } finally {
    db.get = originalGet;
    db.run = originalRun;
  }

  const deletedUser = users.find((user) => user.id === 21);
  assert.ok(deletedUser, "Brak usunietego uzytkownika.");
  assert.match(
    deletedUser.email,
    /^deleted-user-21-\d+@alfee\.invalid$/,
    "Email usunietego konta powinien byc zanonimizowany."
  );
  assert.ok(deletedUser.deleted_at, "Usuniete konto powinno miec znacznik deleted_at.");

  const recreatedUsers = users.filter(
    (user) => user.email.toLowerCase() === "pracownik@example.com" && user.deleted_at == null
  );
  assert.equal(recreatedUsers.length, 1, "Oczekiwano ponownego utworzenia konta na ten sam email.");
  assert.notEqual(
    recreatedUsers[0].id,
    21,
    "Ponownie utworzone konto powinno miec nowy identyfikator."
  );
  assert.equal(managerRes.redirectedTo, "/manager/employees/new");
  assert.ok(
    userOrganizations.some(
      (membership) =>
        membership.user_id === recreatedUsers[0].id && membership.organization_id === 7
    ),
    "Nowe konto powinno zostac przypisane do organizacji kierownika."
  );
});
