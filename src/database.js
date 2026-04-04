const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const configuredPath = process.env.DB_PATH || path.join("data", "app.db");
const dbPath = path.isAbsolute(configuredPath)
  ? configuredPath
  : path.join(process.cwd(), configuredPath);

const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const sqlite = new sqlite3.Database(dbPath);

const db = {
  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      sqlite.run(sql, params, function callback(error) {
        if (error) {
          reject(error);
          return;
        }
        resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  },
  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      sqlite.get(sql, params, (error, row) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(row);
      });
    });
  },
  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      sqlite.all(sql, params, (error, rows) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(rows);
      });
    });
  },
};

async function tableHasColumn(tableName, columnName) {
  const columns = await db.all(`PRAGMA table_info(${tableName})`);
  return columns.some((column) => column.name === columnName);
}

async function migrateTenantData() {
  const defaultOrganizationName =
    process.env.DEFAULT_ORGANIZATION_NAME || "Domyslna organizacja";

  let firstOrganization = await db.get(
    "SELECT id FROM organizations ORDER BY id ASC LIMIT 1"
  );

  const tasksWithoutOrganization = await db.get(
    "SELECT COUNT(*) AS total FROM tasks WHERE organization_id IS NULL"
  );
  const usersRequiringMembership = await db.get(
    "SELECT COUNT(*) AS total FROM users WHERE role IN ('manager', 'employee')"
  );

  if (
    !firstOrganization &&
    (Number(tasksWithoutOrganization.total || 0) > 0 ||
      Number(usersRequiringMembership.total || 0) > 0)
  ) {
    const created = await db.run(
      "INSERT INTO organizations (name) VALUES (?)",
      [defaultOrganizationName]
    );
    firstOrganization = { id: created.lastID };
  }

  if (
    firstOrganization &&
    Number(tasksWithoutOrganization.total || 0) > 0
  ) {
    await db.run(
      "UPDATE tasks SET organization_id = ? WHERE organization_id IS NULL",
      [firstOrganization.id]
    );
  }

  if (firstOrganization) {
    const membershipCount = await db.get(
      "SELECT COUNT(*) AS total FROM user_organizations"
    );
    if (Number(membershipCount.total || 0) === 0) {
      await db.run(
        `
        INSERT OR IGNORE INTO user_organizations (user_id, organization_id)
        SELECT id, ?
        FROM users
        WHERE role IN ('manager', 'employee')
        `,
        [firstOrganization.id]
      );
    }
  }
}

async function initDatabase() {
  await db.run("PRAGMA foreign_keys = ON");

  await db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      google_id TEXT UNIQUE,
      username TEXT,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      auth_provider TEXT NOT NULL DEFAULT 'google',
      password_hash TEXT,
      failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      role TEXT NOT NULL DEFAULT 'employee',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  if (!(await tableHasColumn("users", "username"))) {
    await db.run("ALTER TABLE users ADD COLUMN username TEXT");
  }

  if (!(await tableHasColumn("users", "auth_provider"))) {
    await db.run(
      "ALTER TABLE users ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'google'"
    );
  }

  if (!(await tableHasColumn("users", "is_active"))) {
    await db.run(
      "ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1"
    );
  }

  if (!(await tableHasColumn("users", "password_hash"))) {
    await db.run("ALTER TABLE users ADD COLUMN password_hash TEXT");
  }

  if (!(await tableHasColumn("users", "failed_login_attempts"))) {
    await db.run(
      "ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0"
    );
  }

  if (!(await tableHasColumn("users", "locked_until"))) {
    await db.run("ALTER TABLE users ADD COLUMN locked_until TEXT");
  }

  await db.run("UPDATE users SET is_active = 1 WHERE is_active IS NULL");
  await db.run(
    "UPDATE users SET failed_login_attempts = 0 WHERE failed_login_attempts IS NULL"
  );

  await db.run(`
    CREATE TABLE IF NOT EXISTS organizations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS user_organizations (
      user_id INTEGER NOT NULL,
      organization_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, organization_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      organization_id INTEGER,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  if (!(await tableHasColumn("tasks", "organization_id"))) {
    await db.run("ALTER TABLE tasks ADD COLUMN organization_id INTEGER");
  }

  await db.run(`
    CREATE TABLE IF NOT EXISTS task_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      step_text TEXT NOT NULL,
      position INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      employee_id INTEGER NOT NULL,
      assigned_by INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'in_progress',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (employee_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS assignment_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_id INTEGER NOT NULL,
      source_step_id INTEGER,
      step_text TEXT NOT NULL,
      position INTEGER NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS step_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_step_id INTEGER NOT NULL,
      image_path TEXT NOT NULL,
      uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (assignment_step_id) REFERENCES assignment_steps(id) ON DELETE CASCADE
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL DEFAULT 'assignment',
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      url TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      read_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await db.run(
    "CREATE INDEX IF NOT EXISTS idx_tasks_organization_id ON tasks (organization_id)"
  );
  await db.run(
    "CREATE INDEX IF NOT EXISTS idx_user_organizations_user_id ON user_organizations (user_id)"
  );
  await db.run(
    "CREATE INDEX IF NOT EXISTS idx_user_organizations_org_id ON user_organizations (organization_id)"
  );
  await db.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_unique ON users (username)"
  );
  await db.run(
    "CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications (user_id, is_read)"
  );

  await migrateTenantData();
}

module.exports = {
  db,
  dbPath,
  initDatabase,
};
