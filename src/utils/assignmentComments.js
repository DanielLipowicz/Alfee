const { db } = require("../database");

const MAX_COMMENT_LENGTH = 2000;

function normalizeCommentText(rawValue) {
  return String(rawValue || "").trim();
}

function validateCommentText(commentText) {
  if (!commentText) {
    return "Komentarz nie moze byc pusty.";
  }
  if (commentText.length > MAX_COMMENT_LENGTH) {
    return `Komentarz moze miec maksymalnie ${MAX_COMMENT_LENGTH} znakow.`;
  }
  return null;
}

async function listAssignmentComments(assignmentId) {
  return db.all(
    `
    SELECT
      c.id,
      c.assignment_id,
      c.user_id,
      c.comment_text,
      c.created_at,
      u.name AS author_name,
      u.role AS author_role
    FROM assignment_comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.assignment_id = ?
    ORDER BY c.created_at ASC, c.id ASC
    `,
    [assignmentId]
  );
}

function notificationUrlForRole(role, assignmentId, taskId) {
  if (role === "employee") {
    return `/employee/tasks/${assignmentId}`;
  }
  if (role === "observer") {
    return `/observer/tasks/${taskId}/assignments/${assignmentId}`;
  }
  return `/manager/assignments/${assignmentId}`;
}

function commentExcerpt(commentText) {
  const normalized = String(commentText || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= 140) {
    return normalized;
  }
  return `${normalized.slice(0, 137)}...`;
}

async function addAssignmentCommentAndNotify(assignmentId, author, commentText) {
  const assignment = await db.get(
    `
    SELECT
      a.id,
      a.task_id,
      a.employee_id,
      a.assigned_by,
      a.observer_id,
      t.title AS task_title
    FROM assignments a
    JOIN tasks t ON t.id = a.task_id
    WHERE a.id = ?
    `,
    [assignmentId]
  );

  if (!assignment) {
    return null;
  }

  await db.run(
    `
    INSERT INTO assignment_comments (assignment_id, user_id, comment_text)
    VALUES (?, ?, ?)
    `,
    [assignment.id, author.id, commentText]
  );

  const recipientIds = Array.from(
    new Set(
      [assignment.employee_id, assignment.assigned_by, assignment.observer_id]
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0 && value !== Number(author.id))
    )
  );

  if (recipientIds.length === 0) {
    return assignment;
  }

  const placeholders = recipientIds.map(() => "?").join(", ");
  const recipients = await db.all(
    `
    SELECT id, role
    FROM users
    WHERE id IN (${placeholders}) AND is_active = 1
    `,
    recipientIds
  );

  const excerpt = commentExcerpt(commentText);
  const authorLabel = author.name || author.email || "Uzytkownik";
  const title = "Nowy komentarz do wykonania zadania";
  const message = `${authorLabel} dodal(a) komentarz do wykonania "${assignment.task_title}": "${excerpt}"`;

  for (const recipient of recipients) {
    await db.run(
      `
      INSERT INTO notifications (user_id, type, title, message, url)
      VALUES (?, 'assignment_comment', ?, ?, ?)
      `,
      [
        recipient.id,
        title,
        message,
        notificationUrlForRole(recipient.role, assignment.id, assignment.task_id),
      ]
    );
  }

  return assignment;
}

module.exports = {
  MAX_COMMENT_LENGTH,
  normalizeCommentText,
  validateCommentText,
  listAssignmentComments,
  addAssignmentCommentAndNotify,
};
