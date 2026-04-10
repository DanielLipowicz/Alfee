const express = require("express");
const crypto = require("crypto");

const { db } = require("../database");
const { ensureAuthenticated, ensureManager } = require("../middleware/auth");
const { ensureManagerOrganization } = require("../middleware/tenant");
const { hashPassword } = require("../security/password");
const { setFlash } = require("../utils/flash");
const { normalizeSteps, withProgress } = require("../utils/tasks");
const {
  addAssignmentCommentAndNotify,
  listAssignmentComments,
  normalizeCommentText,
  validateCommentText,
} = require("../utils/assignmentComments");

const router = express.Router();

router.use(ensureAuthenticated, ensureManager);

async function refreshUnreadNotificationsCount(userId, res) {
  const unread = await db.get(
    "SELECT COUNT(*) AS total FROM notifications WHERE user_id = ? AND is_read = 0",
    [userId]
  );
  res.locals.unreadNotifications = Number(unread?.total || 0);
}

function normalizeEmail(rawEmail) {
  return String(rawEmail || "").trim().toLowerCase();
}

function normalizeText(rawValue) {
  return String(rawValue || "").trim();
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePasswordStrength(password) {
  const value = String(password || "");
  if (value.length < 10) {
    return "Haslo musi miec co najmniej 10 znakow.";
  }
  if (!/[a-z]/.test(value)) {
    return "Haslo musi zawierac mala litere.";
  }
  if (!/[A-Z]/.test(value)) {
    return "Haslo musi zawierac wielka litere.";
  }
  if (!/[0-9]/.test(value)) {
    return "Haslo musi zawierac cyfre.";
  }
  if (!/[^a-zA-Z0-9]/.test(value)) {
    return "Haslo musi zawierac znak specjalny.";
  }
  return null;
}

function buildLocalIdentity(email) {
  return `local:${email}:${Date.now()}:${Math.round(Math.random() * 1e9)}`;
}

function buildDefaultObserverFormData(overrides = {}) {
  return {
    email: "",
    ...overrides,
  };
}

function renderCreateEmployeeForm(
  res,
  formData,
  flashMessage = null,
  statusCode = 200,
  observerFormData = buildDefaultObserverFormData(),
  generatedObserverCredentials = null
) {
  if (flashMessage) {
    res.locals.flash = flashMessage;
  }
  return res.status(statusCode).render("manager/create-employee", {
    title: "Nowy pracownik i obserwator",
    formData,
    observerFormData,
    generatedObserverCredentials,
  });
}

function popGeneratedObserverCredentials(req) {
  if (!req.session) {
    return null;
  }
  const credentials = req.session.generatedObserverCredentials || null;
  delete req.session.generatedObserverCredentials;
  return credentials;
}

async function rollbackSafely() {
  try {
    await db.run("ROLLBACK");
  } catch (_error) {
    // Brak aktywnej transakcji.
  }
}

function pickRandomCharacter(charset) {
  return charset[crypto.randomInt(0, charset.length)];
}

function generateTemporaryPassword(length = 14) {
  const lowercase = "abcdefghijkmnopqrstuvwxyz";
  const uppercase = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const special = "!@#$%^&*()-_=+?";
  const all = `${lowercase}${uppercase}${digits}${special}`;

  const requiredCharacters = [
    pickRandomCharacter(lowercase),
    pickRandomCharacter(uppercase),
    pickRandomCharacter(digits),
    pickRandomCharacter(special),
  ];

  while (requiredCharacters.length < length) {
    requiredCharacters.push(pickRandomCharacter(all));
  }

  for (let index = requiredCharacters.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(0, index + 1);
    const temporary = requiredCharacters[index];
    requiredCharacters[index] = requiredCharacters[swapIndex];
    requiredCharacters[swapIndex] = temporary;
  }

  return requiredCharacters.join("");
}

function createObserverNameFromEmail(email) {
  const localPart = String(email || "").split("@")[0] || "";
  const normalized = localPart
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return "Obserwator";
  }

  const titleCased = normalized
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

  const name = `Obserwator ${titleCased}`.trim();
  return name.length > 120 ? name.slice(0, 120) : name;
}

function parseObserverId(rawObserverId) {
  const observerId = Number(rawObserverId);
  return Number.isInteger(observerId) && observerId > 0 ? observerId : null;
}

async function loadObserversForOrganization(organizationId) {
  return db.all(
    `
    SELECT
      u.id,
      u.name,
      u.email
    FROM users u
    JOIN user_organizations uo ON uo.user_id = u.id
    WHERE uo.organization_id = ? AND u.role = 'observer'
    ORDER BY u.name ASC
    `,
    [organizationId]
  );
}

router.post("/organization/switch", (req, res) => {
  const organizationId = Number(req.body.organizationId);
  const organizations = req.userOrganizations || [];

  if (!organizationId) {
    setFlash(req, "error", "Wybierz organizacje.");
    return res.redirect("/manager/dashboard");
  }

  const allowed = organizations.some(
    (organization) => Number(organization.id) === organizationId
  );

  if (!allowed) {
    setFlash(req, "error", "Nie masz dostepu do tej organizacji.");
    return res.redirect("/manager/dashboard");
  }

  req.session.activeOrganizationId = organizationId;
  setFlash(req, "success", "Przelaczono aktywna organizacje.");
  return res.redirect(req.get("referer") || "/manager/dashboard");
});

router.use(ensureManagerOrganization);

router.get("/employees/new", (req, res) => {
  const generatedObserverCredentials = popGeneratedObserverCredentials(req);
  return renderCreateEmployeeForm(res, {
    email: "",
    name: "",
    password: "",
    passwordConfirm: "",
  }, null, 200, buildDefaultObserverFormData(), generatedObserverCredentials);
});

router.post("/employees", async (req, res, next) => {
  const email = normalizeEmail(req.body.email);
  const name = normalizeText(req.body.name);
  const password = String(req.body.password || "");
  const passwordConfirm = String(req.body.passwordConfirm || "");
  const observerFormData = buildDefaultObserverFormData({
    email: normalizeEmail(req.body.observerEmail),
  });
  const formData = {
    email,
    name,
    password: "",
    passwordConfirm: "",
  };

  if (!email || !name) {
    return renderCreateEmployeeForm(
      res,
      formData,
      { type: "error", text: "Podaj email oraz imie i nazwisko." },
      400,
      observerFormData
    );
  }

  if (!validateEmail(email)) {
    return renderCreateEmployeeForm(
      res,
      formData,
      { type: "error", text: "Podaj poprawny adres email." },
      400,
      observerFormData
    );
  }

  if (name.length > 120) {
    return renderCreateEmployeeForm(
      res,
      formData,
      { type: "error", text: "Imie i nazwisko moze miec maksymalnie 120 znakow." },
      400,
      observerFormData
    );
  }

  const passwordError = validatePasswordStrength(password);
  if (passwordError) {
    return renderCreateEmployeeForm(
      res,
      formData,
      { type: "error", text: passwordError },
      400,
      observerFormData
    );
  }

  if (password !== passwordConfirm) {
    return renderCreateEmployeeForm(
      res,
      formData,
      { type: "error", text: "Hasla musza byc identyczne." },
      400,
      observerFormData
    );
  }

  try {
    const existingByEmail = await db.get(
      "SELECT id FROM users WHERE lower(email) = lower(?)",
      [email]
    );

    if (existingByEmail) {
      return renderCreateEmployeeForm(
        res,
        formData,
        { type: "error", text: "Ten email jest juz zarejestrowany." },
        409,
        observerFormData
      );
    }

    const localIdentity = buildLocalIdentity(email);
    const passwordHash = hashPassword(password);

    await db.run("BEGIN TRANSACTION");
    const created = await db.run(
      `
      INSERT INTO users (google_id, email, name, auth_provider, password_hash, is_active, role)
      VALUES (?, ?, ?, 'local', ?, 1, 'employee')
      `,
      [localIdentity, email, name, passwordHash]
    );

    await db.run(
      `
      INSERT OR IGNORE INTO user_organizations (user_id, organization_id)
      VALUES (?, ?)
      `,
      [created.lastID, req.activeOrganizationId]
    );
    await db.run("COMMIT");

    setFlash(
      req,
      "success",
      `Utworzono konto pracownika (${email}) i przypisano je do aktywnej organizacji.`
    );
    return res.redirect("/manager/employees/new");
  } catch (error) {
    await rollbackSafely();
    return next(error);
  }
});

router.post("/observers", async (req, res, next) => {
  const email = normalizeEmail(req.body.email);
  const observerFormData = buildDefaultObserverFormData({ email });

  if (!email) {
    return renderCreateEmployeeForm(
      res,
      {
        email: "",
        name: "",
        password: "",
        passwordConfirm: "",
      },
      { type: "error", text: "Podaj email obserwatora." },
      400,
      observerFormData
    );
  }

  if (!validateEmail(email)) {
    return renderCreateEmployeeForm(
      res,
      {
        email: "",
        name: "",
        password: "",
        passwordConfirm: "",
      },
      { type: "error", text: "Podaj poprawny adres email obserwatora." },
      400,
      observerFormData
    );
  }

  try {
    const existingByEmail = await db.get(
      "SELECT id FROM users WHERE lower(email) = lower(?)",
      [email]
    );

    if (existingByEmail) {
      return renderCreateEmployeeForm(
        res,
        {
          email: "",
          name: "",
          password: "",
          passwordConfirm: "",
        },
        { type: "error", text: "Ten email jest juz zarejestrowany." },
        409,
        observerFormData
      );
    }

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = hashPassword(temporaryPassword);
    const localIdentity = buildLocalIdentity(email);
    const observerName = createObserverNameFromEmail(email);

    await db.run("BEGIN TRANSACTION");
    const created = await db.run(
      `
      INSERT INTO users (google_id, email, name, auth_provider, password_hash, is_active, role)
      VALUES (?, ?, ?, 'local', ?, 1, 'observer')
      `,
      [localIdentity, email, observerName, passwordHash]
    );

    await db.run(
      `
      INSERT OR IGNORE INTO user_organizations (user_id, organization_id)
      VALUES (?, ?)
      `,
      [created.lastID, req.activeOrganizationId]
    );
    await db.run("COMMIT");

    if (req.session) {
      req.session.generatedObserverCredentials = {
        email,
        password: temporaryPassword,
      };
    }

    setFlash(
      req,
      "success",
      `Utworzono konto obserwatora (${email}). Skopiuj haslo startowe z pola ponizej i przekaz je bezpiecznym kanalem.`
    );
    return res.redirect("/manager/employees/new");
  } catch (error) {
    await rollbackSafely();
    return next(error);
  }
});

router.get("/dashboard", async (req, res, next) => {
  try {
    const organizationId = req.activeOrganizationId;

    const stats = await Promise.all([
      db.get("SELECT COUNT(*) AS count FROM tasks WHERE organization_id = ?", [
        organizationId,
      ]),
      db.get(
        `
        SELECT COUNT(*) AS count
        FROM users u
        JOIN user_organizations uo ON uo.user_id = u.id
        WHERE uo.organization_id = ? AND u.role = 'employee'
        `,
        [organizationId]
      ),
      db.get(
        `
        SELECT COUNT(*) AS count
        FROM assignments a
        JOIN tasks t ON t.id = a.task_id
        WHERE t.organization_id = ?
        `,
        [organizationId]
      ),
      db.get(
        `
        SELECT COUNT(*) AS count
        FROM assignments a
        JOIN tasks t ON t.id = a.task_id
        WHERE t.organization_id = ? AND a.status = 'in_progress'
        `,
        [organizationId]
      ),
    ]);

    const recentAssignments = await db.all(
      `
      SELECT
        a.id,
        a.status,
        a.created_at,
        t.title,
        u.name AS employee_name,
        SUM(CASE WHEN s.completed = 1 THEN 1 ELSE 0 END) AS completed_steps,
        COUNT(s.id) AS total_steps
      FROM assignments a
      JOIN tasks t ON t.id = a.task_id
      JOIN users u ON u.id = a.employee_id
      LEFT JOIN assignment_steps s ON s.assignment_id = a.id
      WHERE t.organization_id = ?
      GROUP BY a.id
      ORDER BY a.created_at DESC
      LIMIT 10
      `,
      [organizationId]
    );

    return res.render("manager/dashboard", {
      title: "Panel kierownika",
      stats: {
        tasks: stats[0].count,
        employees: stats[1].count,
        assignments: stats[2].count,
        active: stats[3].count,
      },
      recentAssignments: withProgress(recentAssignments),
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/tasks", async (req, res, next) => {
  try {
    const tasks = await db.all(
      `
      SELECT
        t.id,
        t.title,
        t.observer_id,
        t.created_at,
        observer.name AS observer_name,
        COUNT(DISTINCT ts.id) AS step_count,
        COUNT(DISTINCT a.id) AS assignment_count
      FROM tasks t
      LEFT JOIN users observer ON observer.id = t.observer_id
      LEFT JOIN task_steps ts ON ts.task_id = t.id
      LEFT JOIN assignments a ON a.task_id = t.id
      WHERE t.organization_id = ?
      GROUP BY t.id
      ORDER BY t.created_at DESC
      `,
      [req.activeOrganizationId]
    );

    return res.render("manager/tasks", {
      title: "Zadania",
      tasks,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/tasks/new", async (req, res, next) => {
  try {
    const observers = await loadObserversForOrganization(req.activeOrganizationId);
    return res.render("manager/task-form", {
      title: "Nowe zadanie",
      formMode: "create",
      task: null,
      taskSteps: ["", ""],
      observers,
      selectedObserverId: null,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/tasks", async (req, res, next) => {
  const title = String(req.body.title || "").trim();
  const steps = normalizeSteps(req.body.steps);
  const observerId = parseObserverId(req.body.observerId);

  if (!title || steps.length === 0) {
    setFlash(
      req,
      "error",
      "Podaj nazwe zadania i przynajmniej jedna czynnosc do wykonania."
    );
    return res.redirect("/manager/tasks/new");
  }

  try {
    if (observerId) {
      const observer = await db.get(
        `
        SELECT u.id
        FROM users u
        JOIN user_organizations uo ON uo.user_id = u.id
        WHERE u.id = ? AND u.role = 'observer' AND uo.organization_id = ?
        `,
        [observerId, req.activeOrganizationId]
      );
      if (!observer) {
        setFlash(req, "error", "Wybrany obserwator nie nalezy do tej organizacji.");
        return res.redirect("/manager/tasks/new");
      }
    }

    await db.run("BEGIN TRANSACTION");
    const createdTask = await db.run(
      `
      INSERT INTO tasks (title, organization_id, observer_id, created_by)
      VALUES (?, ?, ?, ?)
      `,
      [title, req.activeOrganizationId, observerId, req.user.id]
    );

    for (let index = 0; index < steps.length; index += 1) {
      await db.run(
        "INSERT INTO task_steps (task_id, step_text, position) VALUES (?, ?, ?)",
        [createdTask.lastID, steps[index], index + 1]
      );
    }
    await db.run("COMMIT");
    setFlash(req, "success", "Utworzono zadanie.");
    return res.redirect("/manager/tasks");
  } catch (error) {
    await rollbackSafely();
    return next(error);
  }
});

router.get("/tasks/:taskId/edit", async (req, res, next) => {
  try {
    const [task, observers] = await Promise.all([
      db.get("SELECT * FROM tasks WHERE id = ? AND organization_id = ?", [
        req.params.taskId,
        req.activeOrganizationId,
      ]),
      loadObserversForOrganization(req.activeOrganizationId),
    ]);
    if (!task) {
      return res.status(404).render("error", {
        title: "Brak zadania",
        message: "Nie znaleziono wskazanego zadania.",
      });
    }

    const taskSteps = await db.all(
      "SELECT * FROM task_steps WHERE task_id = ? ORDER BY position",
      [task.id]
    );

    return res.render("manager/task-form", {
      title: "Edycja zadania",
      formMode: "edit",
      task,
      taskSteps: taskSteps.map((step) => step.step_text),
      observers,
      selectedObserverId: task.observer_id ? Number(task.observer_id) : null,
    });
  } catch (error) {
    return next(error);
  }
});

router.put("/tasks/:taskId", async (req, res, next) => {
  const title = String(req.body.title || "").trim();
  const steps = normalizeSteps(req.body.steps);
  const observerId = parseObserverId(req.body.observerId);

  if (!title || steps.length === 0) {
    setFlash(
      req,
      "error",
      "Podaj nazwe zadania i przynajmniej jedna czynnosc do wykonania."
    );
    return res.redirect(`/manager/tasks/${req.params.taskId}/edit`);
  }

  try {
    if (observerId) {
      const observer = await db.get(
        `
        SELECT u.id
        FROM users u
        JOIN user_organizations uo ON uo.user_id = u.id
        WHERE u.id = ? AND u.role = 'observer' AND uo.organization_id = ?
        `,
        [observerId, req.activeOrganizationId]
      );
      if (!observer) {
        setFlash(req, "error", "Wybrany obserwator nie nalezy do tej organizacji.");
        return res.redirect(`/manager/tasks/${req.params.taskId}/edit`);
      }
    }

    const task = await db.get(
      "SELECT id FROM tasks WHERE id = ? AND organization_id = ?",
      [req.params.taskId, req.activeOrganizationId]
    );
    if (!task) {
      return res.status(404).render("error", {
        title: "Brak zadania",
        message: "Nie znaleziono wskazanego zadania.",
      });
    }

    await db.run("BEGIN TRANSACTION");
    await db.run("UPDATE tasks SET title = ?, observer_id = ? WHERE id = ?", [
      title,
      observerId,
      task.id,
    ]);
    await db.run("DELETE FROM task_steps WHERE task_id = ?", [task.id]);
    for (let index = 0; index < steps.length; index += 1) {
      await db.run(
        "INSERT INTO task_steps (task_id, step_text, position) VALUES (?, ?, ?)",
        [task.id, steps[index], index + 1]
      );
    }
    await db.run("COMMIT");

    setFlash(req, "success", "Zaktualizowano zadanie.");
    return res.redirect("/manager/tasks");
  } catch (error) {
    await rollbackSafely();
    return next(error);
  }
});

router.post("/tasks/:taskId/copy", async (req, res, next) => {
  try {
    const task = await db.get(
      "SELECT * FROM tasks WHERE id = ? AND organization_id = ?",
      [req.params.taskId, req.activeOrganizationId]
    );
    if (!task) {
      return res.status(404).render("error", {
        title: "Brak zadania",
        message: "Nie znaleziono wskazanego zadania.",
      });
    }

    const steps = await db.all(
      "SELECT * FROM task_steps WHERE task_id = ? ORDER BY position",
      [task.id]
    );

    await db.run("BEGIN TRANSACTION");
    const copied = await db.run(
      `
      INSERT INTO tasks (title, organization_id, observer_id, created_by)
      VALUES (?, ?, ?, ?)
      `,
      [`${task.title} (kopia)`, req.activeOrganizationId, task.observer_id, req.user.id]
    );
    for (let index = 0; index < steps.length; index += 1) {
      await db.run(
        "INSERT INTO task_steps (task_id, step_text, position) VALUES (?, ?, ?)",
        [copied.lastID, steps[index].step_text, index + 1]
      );
    }
    await db.run("COMMIT");

    setFlash(req, "success", "Skopiowano zadanie.");
    return res.redirect("/manager/tasks");
  } catch (error) {
    await rollbackSafely();
    return next(error);
  }
});

router.delete("/tasks/:taskId", async (req, res, next) => {
  try {
    const task = await db.get(
      "SELECT id FROM tasks WHERE id = ? AND organization_id = ?",
      [req.params.taskId, req.activeOrganizationId]
    );
    if (!task) {
      setFlash(req, "error", "Nie znaleziono zadania do usuniecia.");
      return res.redirect("/manager/tasks");
    }

    await db.run("DELETE FROM tasks WHERE id = ?", [task.id]);
    setFlash(req, "success", "Usunieto zadanie.");
    return res.redirect("/manager/tasks");
  } catch (error) {
    return next(error);
  }
});

router.get("/tasks/:taskId/assign", async (req, res, next) => {
  try {
    const [task, employees] = await Promise.all([
      db.get("SELECT * FROM tasks WHERE id = ? AND organization_id = ?", [
        req.params.taskId,
        req.activeOrganizationId,
      ]),
      db.all(
        `
        SELECT
          u.id,
          u.name,
          u.email
        FROM users u
        JOIN user_organizations uo ON uo.user_id = u.id
        WHERE uo.organization_id = ? AND u.role = 'employee'
        ORDER BY u.name ASC
        `,
        [req.activeOrganizationId]
      ),
    ]);

    if (!task) {
      return res.status(404).render("error", {
        title: "Brak zadania",
        message: "Nie znaleziono wskazanego zadania.",
      });
    }

    return res.render("manager/assign-task", {
      title: "Przydziel zadanie",
      task,
      employees,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/tasks/:taskId/assign", async (req, res, next) => {
  const employeeId = Number(req.body.employeeId);
  const sendNotification = req.body.sendNotification === "on";
  if (!employeeId) {
    setFlash(req, "error", "Wybierz pracownika.");
    return res.redirect(`/manager/tasks/${req.params.taskId}/assign`);
  }

  try {
    const [task, employee, steps] = await Promise.all([
      db.get("SELECT * FROM tasks WHERE id = ? AND organization_id = ?", [
        req.params.taskId,
        req.activeOrganizationId,
      ]),
      db.get(
        `
        SELECT
          u.id,
          u.name,
          u.email
        FROM users u
        JOIN user_organizations uo ON uo.user_id = u.id
        WHERE u.id = ? AND u.role = 'employee' AND uo.organization_id = ?
        `,
        [employeeId, req.activeOrganizationId]
      ),
      db.all(
        "SELECT * FROM task_steps WHERE task_id = ? ORDER BY position ASC",
        [req.params.taskId]
      ),
    ]);

    if (!task) {
      return res.status(404).render("error", {
        title: "Brak zadania",
        message: "Nie znaleziono wskazanego zadania.",
      });
    }
    if (!employee) {
      setFlash(
        req,
        "error",
        "Wybrany uzytkownik nie jest pracownikiem w tej organizacji."
      );
      return res.redirect(`/manager/tasks/${task.id}/assign`);
    }
    if (steps.length === 0) {
      setFlash(req, "error", "Nie mozna przydzielic zadania bez czynnosci.");
      return res.redirect("/manager/tasks");
    }

    await db.run("BEGIN TRANSACTION");
    const assignment = await db.run(
      `
      INSERT INTO assignments (task_id, employee_id, assigned_by, observer_id, status)
      VALUES (?, ?, ?, ?, 'in_progress')
      `,
      [task.id, employee.id, req.user.id, task.observer_id]
    );

    for (let index = 0; index < steps.length; index += 1) {
      await db.run(
        `
        INSERT INTO assignment_steps (assignment_id, source_step_id, step_text, position)
        VALUES (?, ?, ?, ?)
        `,
        [assignment.lastID, steps[index].id, steps[index].step_text, index + 1]
      );
    }

    if (sendNotification) {
      await db.run(
        `
        INSERT INTO notifications (user_id, type, title, message, url)
        VALUES (?, 'assignment', ?, ?, ?)
        `,
        [
          employee.id,
          "Nowe przydzielone zadanie",
          `Otrzymales nowe zadanie: ${task.title}`,
          `/employee/tasks/${assignment.lastID}`,
        ]
      );
    }

    await db.run("COMMIT");

    setFlash(
      req,
      "success",
      sendNotification
        ? `Przydzielono zadanie "${task.title}" do ${employee.name} i wyslano powiadomienie.`
        : `Przydzielono zadanie "${task.title}" do ${employee.name}.`
    );
    return res.redirect("/manager/assignments");
  } catch (error) {
    await rollbackSafely();
    return next(error);
  }
});

router.get("/assignments", async (req, res, next) => {
  try {
    const assignments = await db.all(
      `
      SELECT
        a.id,
        a.status,
        a.created_at,
        t.title,
        u.name AS employee_name,
        u.email AS employee_email,
        SUM(CASE WHEN s.completed = 1 THEN 1 ELSE 0 END) AS completed_steps,
        COUNT(s.id) AS total_steps
      FROM assignments a
      JOIN tasks t ON t.id = a.task_id
      JOIN users u ON u.id = a.employee_id
      LEFT JOIN assignment_steps s ON s.assignment_id = a.id
      WHERE t.organization_id = ?
      GROUP BY a.id
      ORDER BY a.created_at DESC
      `,
      [req.activeOrganizationId]
    );

    return res.render("manager/assignments", {
      title: "Wykonania zadan",
      assignments: withProgress(assignments),
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/assignments/:assignmentId", async (req, res, next) => {
  try {
    const assignment = await db.get(
      `
      SELECT
        a.*,
        t.title,
        u.name AS employee_name,
        u.email AS employee_email
      FROM assignments a
      JOIN tasks t ON t.id = a.task_id
      JOIN users u ON u.id = a.employee_id
      WHERE a.id = ? AND t.organization_id = ?
      `,
      [req.params.assignmentId, req.activeOrganizationId]
    );

    if (!assignment) {
      return res.status(404).render("error", {
        title: "Brak przydzialu",
        message: "Nie znaleziono wskazanego przydzialu zadania.",
      });
    }

    await db.run(
      `
      UPDATE notifications
      SET is_read = 1, read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
      WHERE user_id = ? AND url = ? AND is_read = 0
      `,
      [req.user.id, `/manager/assignments/${assignment.id}`]
    );
    await refreshUnreadNotificationsCount(req.user.id, res);

    const [steps, evidence, comments] = await Promise.all([
      db.all(
        `
        SELECT
          s.id,
          s.step_text,
          s.position,
          s.completed,
          s.completed_at,
          COUNT(e.id) AS evidence_count
        FROM assignment_steps s
        LEFT JOIN step_evidence e ON e.assignment_step_id = s.id
        WHERE s.assignment_id = ?
        GROUP BY s.id
        ORDER BY s.position ASC
        `,
        [assignment.id]
      ),
      db.all(
        `
        SELECT
          e.id,
          e.assignment_step_id,
          e.image_path,
          e.uploaded_at
        FROM step_evidence e
        JOIN assignment_steps s ON s.id = e.assignment_step_id
        WHERE s.assignment_id = ?
        ORDER BY e.uploaded_at DESC
        `,
        [assignment.id]
      ),
      listAssignmentComments(assignment.id),
    ]);

    const evidenceByStep = evidence.reduce((acc, item) => {
      if (!acc[item.assignment_step_id]) {
        acc[item.assignment_step_id] = [];
      }
      acc[item.assignment_step_id].push(item);
      return acc;
    }, {});

    const progress = withProgress([
      {
        completed_steps: steps.filter((step) => Number(step.completed) === 1).length,
        total_steps: steps.length,
      },
    ])[0];

    return res.render("manager/assignment-detail", {
      title: "Wykonanie zadania",
      assignment,
      steps,
      evidenceByStep,
      progress,
      comments,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/assignments/:assignmentId/comments", async (req, res, next) => {
  const commentText = normalizeCommentText(req.body.commentText);
  const redirectTo =
    String(req.body.redirectTo || req.get("referer") || "").trim() ||
    `/manager/assignments/${req.params.assignmentId}`;

  const validationError = validateCommentText(commentText);
  if (validationError) {
    setFlash(req, "error", validationError);
    return res.redirect(redirectTo);
  }

  try {
    const assignment = await db.get(
      `
      SELECT a.id, a.task_id
      FROM assignments a
      JOIN tasks t ON t.id = a.task_id
      WHERE a.id = ? AND t.organization_id = ?
      `,
      [req.params.assignmentId, req.activeOrganizationId]
    );

    if (!assignment) {
      return res.status(404).render("error", {
        title: "Brak przydzialu",
        message: "Nie znaleziono wskazanego przydzialu zadania.",
      });
    }

    await addAssignmentCommentAndNotify(assignment.id, req.user, commentText);
    setFlash(req, "success", "Dodano komentarz.");
    return res.redirect(redirectTo);
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
