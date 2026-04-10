const fs = require("fs");
const path = require("path");
const express = require("express");

const { db } = require("../database");
const { ensureAuthenticated, ensureEmployee } = require("../middleware/auth");
const { setFlash } = require("../utils/flash");
const { withProgress } = require("../utils/tasks");
const { uploadEvidence } = require("../middleware/upload");
const {
  addAssignmentCommentAndNotify,
  listAssignmentComments,
  normalizeCommentText,
  validateCommentText,
} = require("../utils/assignmentComments");

const router = express.Router();

router.use(ensureAuthenticated, ensureEmployee);

async function refreshUnreadNotificationsCount(userId, res) {
  const unread = await db.get(
    "SELECT COUNT(*) AS total FROM notifications WHERE user_id = ? AND is_read = 0",
    [userId]
  );
  res.locals.unreadNotifications = Number(unread?.total || 0);
}

function expectsJson(req) {
  const acceptHeader = req.get("accept") || "";
  return acceptHeader.includes("application/json");
}

function renderTaskError(req, res, statusCode, title, message) {
  if (expectsJson(req)) {
    return res.status(statusCode).json({
      ok: false,
      error: message,
    });
  }

  return res.status(statusCode).render("error", {
    title,
    message,
  });
}

function resolveUploadPath(imagePath) {
  if (typeof imagePath !== "string" || !imagePath.startsWith("/uploads/")) {
    return null;
  }

  const filename = path.basename(imagePath);
  if (!filename || filename === "." || filename === "/") {
    return null;
  }

  return path.join(process.cwd(), "uploads", filename);
}

function removeUploadedFile(imagePath) {
  const fullPath = resolveUploadPath(imagePath);
  if (!fullPath) {
    return;
  }

  fs.rmSync(fullPath, { force: true });
}

function removeUploadedFilesByNames(fileList) {
  if (!Array.isArray(fileList)) {
    return;
  }

  fileList.forEach((file) => {
    if (file?.filename) {
      removeUploadedFile(`/uploads/${file.filename}`);
    }
  });
}

async function updateAssignmentStatus(assignmentId) {
  const [assignment, summary] = await Promise.all([
    db.get(
      `
      SELECT
        a.id,
        a.status,
        a.assigned_by,
        t.title AS task_title,
        u.name AS employee_name
      FROM assignments a
      JOIN tasks t ON t.id = a.task_id
      JOIN users u ON u.id = a.employee_id
      WHERE a.id = ?
      `,
      [assignmentId]
    ),
    db.get(
      `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) AS done,
        MAX(completed_at) AS completed_at
      FROM assignment_steps
      WHERE assignment_id = ?
      `,
      [assignmentId]
    ),
  ]);

  if (!assignment) {
    return null;
  }

  const done = Number(summary.done || 0);
  const total = Number(summary.total || 0);
  const status = total > 0 && done === total ? "completed" : "in_progress";
  const percentage = total > 0 ? Math.round((done / total) * 100) : 0;

  await db.run("UPDATE assignments SET status = ? WHERE id = ?", [
    status,
    assignmentId,
  ]);

  return {
    id: assignment.id,
    previousStatus: assignment.status,
    status,
    assignedBy: assignment.assigned_by,
    employeeName: assignment.employee_name,
    taskTitle: assignment.task_title,
    completedAt: summary.completed_at || null,
    completedSteps: done,
    totalSteps: total,
    percentage,
  };
}

async function getEmployeeAssignment(assignmentId, employeeId) {
  return db.get(
    `
    SELECT
      a.id,
      a.task_id
    FROM assignments a
    JOIN tasks t ON t.id = a.task_id
    JOIN user_organizations uo
      ON uo.organization_id = t.organization_id AND uo.user_id = a.employee_id
    WHERE a.id = ? AND a.employee_id = ?
    `,
    [assignmentId, employeeId]
  );
}

router.get("/tasks", async (req, res, next) => {
  try {
    const assignments = await db.all(
      `
      SELECT
        a.id,
        a.task_id,
        a.status,
        a.created_at,
        t.title,
        o.name AS organization_name,
        SUM(CASE WHEN s.completed = 1 THEN 1 ELSE 0 END) AS completed_steps,
        COUNT(s.id) AS total_steps
      FROM assignments a
      JOIN tasks t ON t.id = a.task_id
      JOIN organizations o ON o.id = t.organization_id
      JOIN user_organizations uo
        ON uo.organization_id = t.organization_id AND uo.user_id = a.employee_id
      LEFT JOIN assignment_steps s ON s.assignment_id = a.id
      WHERE a.employee_id = ?
      GROUP BY a.id
      ORDER BY a.created_at DESC
      `,
      [req.user.id]
    );

    return res.render("employee/tasks", {
      title: "Moje wykonania zadan",
      assignments: withProgress(assignments),
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/tasks/:assignmentId", async (req, res, next) => {
  try {
    const assignment = await db.get(
      `
      SELECT
        a.id,
        a.status,
        a.created_at,
        t.title,
        o.name AS organization_name
      FROM assignments a
      JOIN tasks t ON t.id = a.task_id
      JOIN organizations o ON o.id = t.organization_id
      JOIN user_organizations uo
        ON uo.organization_id = t.organization_id AND uo.user_id = a.employee_id
      WHERE a.id = ? AND a.employee_id = ?
      `,
      [req.params.assignmentId, req.user.id]
    );

    if (!assignment) {
      return res.status(404).render("error", {
        title: "Brak zadania",
        message: "Nie znaleziono wskazanego zadania.",
      });
    }

    const steps = await db.all(
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
    );

    await db.run(
      `
      UPDATE notifications
      SET is_read = 1, read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
      WHERE user_id = ? AND url = ? AND is_read = 0
      `,
      [req.user.id, `/employee/tasks/${assignment.id}`]
    );
    await refreshUnreadNotificationsCount(req.user.id, res);

    const [evidence, comments] = await Promise.all([
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
        completed_steps: steps.filter((step) => Number(step.completed) === 1)
          .length,
        total_steps: steps.length,
      },
    ])[0];

    return res.render("employee/task-detail", {
      title: `Wykonanie: ${assignment.title}`,
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

router.post("/tasks/:assignmentId/comments", async (req, res, next) => {
  const commentText = normalizeCommentText(req.body.commentText);
  const redirectTo =
    String(req.body.redirectTo || req.get("referer") || "").trim() ||
    `/employee/tasks/${req.params.assignmentId}`;

  const validationError = validateCommentText(commentText);
  if (validationError) {
    setFlash(req, "error", validationError);
    return res.redirect(redirectTo);
  }

  try {
    const assignment = await getEmployeeAssignment(req.params.assignmentId, req.user.id);
    if (!assignment) {
      return res.status(404).render("error", {
        title: "Brak zadania",
        message: "Nie znaleziono wskazanego zadania.",
      });
    }

    await addAssignmentCommentAndNotify(assignment.id, req.user, commentText);
    setFlash(req, "success", "Dodano komentarz.");
    return res.redirect(redirectTo);
  } catch (error) {
    return next(error);
  }
});

router.post(
  "/tasks/:assignmentId/steps/:stepId/toggle",
  async (req, res, next) => {
    try {
      const step = await db.get(
        `
        SELECT
          s.id,
          s.completed
        FROM assignment_steps s
        JOIN assignments a ON a.id = s.assignment_id
        JOIN tasks t ON t.id = a.task_id
        JOIN user_organizations uo
          ON uo.organization_id = t.organization_id AND uo.user_id = a.employee_id
        WHERE s.id = ? AND s.assignment_id = ? AND a.employee_id = ?
        `,
        [req.params.stepId, req.params.assignmentId, req.user.id]
      );

      if (!step) {
        return renderTaskError(
          req,
          res,
          404,
          "Brak czynnosci",
          "Nie znaleziono wskazanej czynnosci."
        );
      }

      const isCompleted = Number(step.completed) === 1;
      const targetCompleted = isCompleted ? 0 : 1;
      await db.run(
        `
        UPDATE assignment_steps
        SET completed = ?, completed_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END
        WHERE id = ?
        `,
        [targetCompleted, targetCompleted, step.id]
      );

      const assignmentUpdate = await updateAssignmentStatus(req.params.assignmentId);

      if (
        assignmentUpdate &&
        assignmentUpdate.previousStatus !== "completed" &&
        assignmentUpdate.status === "completed"
      ) {
        const completedAt = assignmentUpdate.completedAt
          ? `${assignmentUpdate.completedAt} UTC`
          : "brak danych";

        await db.run(
          `
          INSERT INTO notifications (user_id, type, title, message, url)
          VALUES (?, 'assignment_completed', ?, ?, ?)
          `,
          [
            assignmentUpdate.assignedBy,
            "Pracownik ukonczyl zadanie",
            `${assignmentUpdate.employeeName} ukonczyl(a) zadanie "${assignmentUpdate.taskTitle}". Data i godzina zakonczenia prac: ${completedAt}.`,
            `/manager/assignments/${assignmentUpdate.id}`,
          ]
        );
      }

      if (expectsJson(req)) {
        return res.json({
          ok: true,
          message: "Zaktualizowano status czynnosci.",
          step: {
            id: step.id,
            completed: targetCompleted,
          },
          assignment: assignmentUpdate
            ? {
                status: assignmentUpdate.status,
                progress: {
                  completed_steps: assignmentUpdate.completedSteps,
                  total_steps: assignmentUpdate.totalSteps,
                  percentage: assignmentUpdate.percentage,
                },
              }
            : null,
        });
      }

      setFlash(req, "success", "Zaktualizowano status czynnosci.");
      return res.redirect(`/employee/tasks/${req.params.assignmentId}`);
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  "/tasks/:assignmentId/steps/:stepId/evidence",
  (req, res, next) => {
    uploadEvidence.array("evidenceImage", 10)(req, res, (error) => {
      if (error) {
        if (expectsJson(req)) {
          res.status(400).json({
            ok: false,
            error: error.message || "Nie udalo sie dodac zdjecia.",
          });
          return;
        }

        setFlash(req, "error", error.message || "Nie udalo sie dodac zdjecia.");
        res.redirect(`/employee/tasks/${req.params.assignmentId}`);
        return;
      }
      next();
    });
  },
  async (req, res, next) => {
    try {
      if (!Array.isArray(req.files) || req.files.length === 0) {
        if (expectsJson(req)) {
          return res.status(400).json({
            ok: false,
            error: "Wybierz co najmniej jedno zdjecie do wyslania.",
          });
        }

        setFlash(req, "error", "Wybierz co najmniej jedno zdjecie do wyslania.");
        return res.redirect(`/employee/tasks/${req.params.assignmentId}`);
      }

      const step = await db.get(
        `
        SELECT
          s.id,
          s.completed
        FROM assignment_steps s
        JOIN assignments a ON a.id = s.assignment_id
        JOIN tasks t ON t.id = a.task_id
        JOIN user_organizations uo
          ON uo.organization_id = t.organization_id AND uo.user_id = a.employee_id
        WHERE s.id = ? AND s.assignment_id = ? AND a.employee_id = ?
        `,
        [req.params.stepId, req.params.assignmentId, req.user.id]
      );

      if (!step) {
        removeUploadedFilesByNames(req.files);
        return renderTaskError(
          req,
          res,
          404,
          "Brak czynnosci",
          "Nie znaleziono wskazanej czynnosci."
        );
      }

      const evidenceItems = [];
      for (const file of req.files) {
        const insertedEvidence = await db.run(
          "INSERT INTO step_evidence (assignment_step_id, image_path) VALUES (?, ?)",
          [step.id, `/uploads/${file.filename}`]
        );

        const evidence = await db.get(
          `
          SELECT
            e.id,
            e.assignment_step_id,
            e.image_path,
            e.uploaded_at
          FROM step_evidence e
          WHERE e.id = ?
          `,
          [insertedEvidence.lastID]
        );
        if (evidence) {
          evidenceItems.push(evidence);
        }
      }

      if (expectsJson(req)) {
        const count = evidenceItems.length;
        return res.json({
          ok: true,
          message:
            count === 1
              ? "Dodano 1 zdjecie jako dowod wykonania."
              : `Dodano ${count} zdjec jako dowod wykonania.`,
          evidenceItems,
        });
      }

      if (evidenceItems.length === 1) {
        setFlash(req, "success", "Dodano 1 zdjecie jako dowod wykonania.");
      } else {
        setFlash(
          req,
          "success",
          `Dodano ${evidenceItems.length} zdjec jako dowod wykonania.`
        );
      }
      return res.redirect(`/employee/tasks/${req.params.assignmentId}`);
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  "/tasks/:assignmentId/steps/:stepId/evidence/:evidenceId/delete",
  async (req, res, next) => {
    try {
      const evidence = await db.get(
        `
        SELECT
          e.id,
          e.image_path
        FROM step_evidence e
        JOIN assignment_steps s ON s.id = e.assignment_step_id
        JOIN assignments a ON a.id = s.assignment_id
        JOIN tasks t ON t.id = a.task_id
        JOIN user_organizations uo
          ON uo.organization_id = t.organization_id AND uo.user_id = a.employee_id
        WHERE
          e.id = ?
          AND e.assignment_step_id = ?
          AND s.assignment_id = ?
          AND a.employee_id = ?
        `,
        [
          req.params.evidenceId,
          req.params.stepId,
          req.params.assignmentId,
          req.user.id,
        ]
      );

      if (!evidence) {
        return renderTaskError(
          req,
          res,
          404,
          "Brak zdjecia",
          "Nie znaleziono wskazanego zdjecia."
        );
      }

      await db.run("DELETE FROM step_evidence WHERE id = ?", [evidence.id]);

      const referenceCount = await db.get(
        "SELECT COUNT(*) AS total FROM step_evidence WHERE image_path = ?",
        [evidence.image_path]
      );

      if (Number(referenceCount?.total || 0) === 0) {
        removeUploadedFile(evidence.image_path);
      }

      if (expectsJson(req)) {
        return res.json({
          ok: true,
          message: "Usunieto zdjecie.",
          evidenceId: Number(evidence.id),
        });
      }

      setFlash(req, "success", "Usunieto zdjecie.");
      return res.redirect(`/employee/tasks/${req.params.assignmentId}`);
    } catch (error) {
      return next(error);
    }
  }
);

module.exports = router;
