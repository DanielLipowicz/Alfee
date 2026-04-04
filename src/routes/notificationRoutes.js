const express = require("express");

const { db } = require("../database");
const { ensureAuthenticated } = require("../middleware/auth");
const { setFlash } = require("../utils/flash");

const router = express.Router();

router.use(ensureAuthenticated);

router.get("/", async (req, res, next) => {
  try {
    const notifications = await db.all(
      `
      SELECT
        id,
        type,
        title,
        message,
        url,
        is_read,
        created_at,
        read_at
      FROM notifications
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 100
      `,
      [req.user.id]
    );

    return res.render("notifications/index", {
      title: "Powiadomienia",
      notifications,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/:notificationId/read", async (req, res, next) => {
  try {
    await db.run(
      `
      UPDATE notifications
      SET is_read = 1, read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
      WHERE id = ? AND user_id = ?
      `,
      [req.params.notificationId, req.user.id]
    );

    const redirectTo = String(req.body.redirectTo || "/notifications").trim();
    return res.redirect(redirectTo || "/notifications");
  } catch (error) {
    return next(error);
  }
});

router.post("/read-all", async (req, res, next) => {
  try {
    await db.run(
      `
      UPDATE notifications
      SET is_read = 1, read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
      WHERE user_id = ? AND is_read = 0
      `,
      [req.user.id]
    );
    setFlash(req, "success", "Wszystkie powiadomienia oznaczono jako przeczytane.");
    return res.redirect("/notifications");
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
