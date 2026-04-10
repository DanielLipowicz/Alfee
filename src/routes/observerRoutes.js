const express = require("express");

const { db } = require("../database");
const { ensureAuthenticated, ensureObserver } = require("../middleware/auth");
const { setFlash } = require("../utils/flash");
const { withProgress } = require("../utils/tasks");
const {
  addAssignmentCommentAndNotify,
  listAssignmentComments,
  normalizeCommentText,
  validateCommentText,
} = require("../utils/assignmentComments");

const router = express.Router();

router.use(ensureAuthenticated, ensureObserver);

async function getObservedTask(taskId, observerId) {
  return db.get(
    `
    SELECT
      t.id,
      t.title,
      t.created_at,
      t.organization_id,
      o.name AS organization_name
    FROM tasks t
    JOIN organizations o ON o.id = t.organization_id
    JOIN user_organizations uo
      ON uo.organization_id = t.organization_id
      AND uo.user_id = ?
    WHERE t.id = ?
      AND (
        t.observer_id = ?
        OR EXISTS (
          SELECT 1
          FROM assignments a
          WHERE a.task_id = t.id AND a.observer_id = ?
        )
      )
    `,
    [observerId, taskId, observerId, observerId]
  );
}

async function getObservedAssignment(assignmentId, observerId) {
  return db.get(
    `
    SELECT
      a.id,
      a.task_id
    FROM assignments a
    JOIN tasks t ON t.id = a.task_id
    JOIN user_organizations uo
      ON uo.organization_id = t.organization_id
      AND uo.user_id = ?
    WHERE a.id = ? AND a.observer_id = ?
    `,
    [observerId, assignmentId, observerId]
  );
}

router.get("/tasks", async (req, res, next) => {
  try {
    const tasks = await db.all(
      `
      SELECT
        t.id,
        t.title,
        t.created_at,
        o.name AS organization_name,
        COUNT(DISTINCT a.id) AS assignment_count,
        SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) AS completed_assignments
      FROM tasks t
      JOIN organizations o ON o.id = t.organization_id
      JOIN user_organizations uo
        ON uo.organization_id = t.organization_id
        AND uo.user_id = ?
      LEFT JOIN assignments a ON a.task_id = t.id AND a.observer_id = ?
      WHERE t.observer_id = ? OR a.id IS NOT NULL
      GROUP BY t.id
      ORDER BY t.created_at DESC
      `,
      [req.user.id, req.user.id, req.user.id]
    );

    return res.render("observer/tasks", {
      title: "Obserwowane zadania (szablony)",
      tasks: tasks.map((task) => ({
        ...task,
        assignment_count: Number(task.assignment_count || 0),
        completed_assignments: Number(task.completed_assignments || 0),
      })),
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/tasks/:taskId", async (req, res, next) => {
  try {
    const task = await getObservedTask(req.params.taskId, req.user.id);

    if (!task) {
      return res.status(404).render("error", {
        title: "Brak zadania",
        message: "Nie znaleziono wskazanego zadania.",
      });
    }

    const assignments = await db.all(
      `
      SELECT
        a.id,
        a.status,
        a.created_at,
        u.name AS employee_name,
        u.email AS employee_email,
        SUM(CASE WHEN s.completed = 1 THEN 1 ELSE 0 END) AS completed_steps,
        COUNT(s.id) AS total_steps,
        COUNT(DISTINCT c.id) AS comment_count
      FROM assignments a
      JOIN users u ON u.id = a.employee_id
      LEFT JOIN assignment_steps s ON s.assignment_id = a.id
      LEFT JOIN assignment_comments c ON c.assignment_id = a.id
      WHERE a.task_id = ? AND a.observer_id = ?
      GROUP BY a.id
      ORDER BY a.created_at DESC
      `,
      [task.id, req.user.id]
    );

    return res.render("observer/task-detail", {
      title: `Zadanie (szablon): ${task.title}`,
      task,
      assignments: withProgress(assignments),
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/tasks/:taskId/assignments/:assignmentId", async (req, res, next) => {
  try {
    const assignment = await db.get(
      `
      SELECT
        a.id,
        a.status,
        a.created_at,
        a.task_id,
        t.title,
        t.organization_id,
        o.name AS organization_name,
        u.name AS employee_name,
        u.email AS employee_email
      FROM assignments a
      JOIN tasks t ON t.id = a.task_id
      JOIN organizations o ON o.id = t.organization_id
      JOIN users u ON u.id = a.employee_id
      JOIN user_organizations uo
        ON uo.organization_id = t.organization_id
        AND uo.user_id = ?
      WHERE a.id = ? AND a.task_id = ? AND a.observer_id = ?
      `,
      [req.user.id, req.params.assignmentId, req.params.taskId, req.user.id]
    );

    if (!assignment) {
      return res.status(404).render("error", {
        title: "Brak przydzialu",
        message: "Nie znaleziono wskazanego przydzialu zadania.",
      });
    }

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

    return res.render("observer/assignment-detail", {
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
    `/observer/tasks`;

  const validationError = validateCommentText(commentText);
  if (validationError) {
    setFlash(req, "error", validationError);
    return res.redirect(redirectTo);
  }

  try {
    const assignment = await getObservedAssignment(req.params.assignmentId, req.user.id);
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
